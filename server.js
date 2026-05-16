/**
 * ══════════════════════════════════════════════════════════
 * OMAX MARINE — Chatbot Backend API
 * Distributeur officiel Osculati France · Le Cannet (06)
 * ══════════════════════════════════════════════════════════
 * 
 * Ce serveur:
 * 1. Reçoit les messages des clients depuis le widget
 * 2. Cherche les produits pertinents dans le catalogue
 * 3. Envoie le tout à Claude pour une réponse experte
 * 4. Retourne la réponse + les produits trouvés
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk').default;
const fs = require('fs');
const path = require('path');

// ── Configuration ──
require('./load-env');

const PORT = process.env.PORT || 3456;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://omaxmarine.fr').split(',').map(s => s.trim());
const RATE_PER_MIN = parseInt(process.env.RATE_LIMIT_PER_MINUTE || '10');

if (!API_KEY || API_KEY.includes('VOTRE_CLE')) {
  console.error('❌ ERREUR: Configurez ANTHROPIC_API_KEY dans le fichier .env');
  process.exit(1);
}

// ── Anthropic Client ──
const anthropic = new Anthropic({ apiKey: API_KEY });

// ── Catalogue ──
const catalogue = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalogue.json'), 'utf-8'));
console.log(`📦 Catalogue chargé: ${catalogue.length} produits`);

// ── Search ──
function norm(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ');
}

const STOP = new Set(['les','des','une','est','que','pour','dans','avec','sur','par','pas','plus',
  'tout','vous','avez','cette','quel','quelle','comment','bonjour','merci','salut','cherche',
  'voudrais','besoin','prix','combien','coute','aide','pouvez','mon','mes','votre','nos',
  'fait','faire','faut','peut','sont','ont','veux','avoir','aussi','tres','bien','oui','non',
  'bon','bonne','jai','cest','bateau','boat']);

function searchCatalogue(query) {
  const terms = norm(query).split(/\s+/).filter(t => t.length > 1 && !STOP.has(t));
  if (!terms.length) return [];

  const scored = [];
  for (const [ref, desc, prix] of catalogue) {
    if (!prix || isNaN(prix)) continue;
    const dn = norm(desc);
    const rn = norm(ref);
    let sc = 0, m = 0;
    for (const t of terms) {
      if (dn.includes(t)) { sc += 3; m++; }
      else if (rn.includes(t)) { sc += 2; m++; }
      else if (t.length >= 4 && dn.includes(t.slice(0, 4))) { sc += 1; m++; }
    }
    if (m === terms.length && terms.length > 1) sc += 5;
    if (sc > 0) scored.push({ ref, desc, prix, sc });
  }

  scored.sort((a, b) => b.sc - a.sc);
  return scored.slice(0, 12);
}

// ── System Prompt ──
const SYSTEM_PROMPT = `You are an elite marine equipment and boat outfitting advisor working for OMAX MARINE, premium nautical supply company and official Osculati France distributor based in Le Cannet (06110), France.

ALWAYS respond in French.

## YOUR ROLE
You are NOT a simple product search engine. You are a consultative marine sales expert.
Your role is to:
- Understand the customer's boat
- Understand their navigation habits
- Identify their real needs
- Recommend the most suitable marine equipment
- Explain technical choices clearly
- Guide them like an experienced marine professional

You must behave like a real expert in: marine equipment, yacht systems, boat maintenance, navigation, safety, marine electrical systems, anchoring, comfort onboard, offshore equipment, fishing equipment, and tropical/Mediterranean marine environments.

## MAIN OBJECTIVE
Never recommend products immediately without understanding the context first.

First:
1. Understand the boat (type, length, sailboat/motorboat)
2. Understand the usage (coastal/offshore, frequency)
3. Understand the navigation area
4. Understand the customer's experience level
5. Understand the problem or goal
6. Then recommend products

## SIZING RULES

### Ancres
- Bateau < 6m : 5-8 kg | 6-8m : 8-12 kg | 8-10m : 12-16 kg | 10-12m : 16-20 kg | 12-15m : 20-30 kg | > 15m : 30-50 kg
- Voilier = poids supérieur | Sable/vase = Delta/DTX | Rocheux = Trefoil | Mixte = Fortress

### Chaîne de mouillage
- Diamètre ≈ longueur(m) ÷ 1.5 | Longueur = 3-5× profondeur max
- < 8m : 6-8mm | 8-12m : 8-10mm | > 12m : 10-12mm

### Pare-battage
- Diamètre = 2cm par mètre de bateau | Min 3 par côté

### Pompe de cale
- < 7m : 500-1000 GPH | 7-12m : 1500-2500 GPH | > 12m : 3000+ GPH

### Gilets de sauvetage
- Côtier < 6 milles : 100N min | Hauturier > 6 milles : 150N min | Pro : 275N

### Guindeau
- Puissance = poids mouillage total × 3
- < 10m : 500-700W | 10-14m : 700-1500W | > 14m : 1500W+

## CONVERSATION STYLE
- Sound human, practical, experienced, reassuring
- Concise: 2-5 sentences + product list when applicable
- Use nautical emojis sparingly (⚓ 🚤 ⛵)
- When listing products use: ▸ **Nom** — Prix € (Réf: XXXX)

## IMPORTANT
If customer asks vague questions → ask about their boat first.
If product not found → orient towards contact: 04 93 45 72 04 / omaxmarine@gmail.com

## COMPANY INFO
- Téléphone: 04 93 45 72 04 / 06 03 68 84 54
- Email: omaxmarine@gmail.com
- Adresse: 11-13 chemin de l'industrie, 06110 Le Cannet
- Site: omaxmarine.fr
- Catalogue: 24 000+ références Osculati
- Délai livraison: délai moyen d'une semaine`;

// ── Express App ──
const app = express();

app.use(helmet());
app.use(express.json({ limit: '10kb' }));
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, etc.) in dev
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error('CORS non autorisé'));
    }
  },
  methods: ['POST'],
  allowedHeaders: ['Content-Type'],
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: RATE_PER_MIN,
  message: { error: 'Trop de requêtes. Veuillez réessayer dans une minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// ── Health Check ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', products: catalogue.length });
});

// ── Chat Endpoint ──
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history = [], boatContext = {} } = req.body;

    if (!message || typeof message !== 'string' || message.length > 2000) {
      return res.status(400).json({ error: 'Message invalide' });
    }

    // Search catalogue
    const results = searchCatalogue(message);

    // Build product context for Claude
    let productCtx = '';
    if (results.length > 0) {
      productCtx = '\n\n## PRODUITS DISPONIBLES DANS NOTRE CATALOGUE:\n' +
        results.map(r => `- ${r.desc} | Réf: ${r.ref} | ${r.prix.toFixed(2)} €`).join('\n');
    }

    // Build boat context
    let boatCtx = '';
    if (boatContext.type || boatContext.length || boatContext.nav) {
      boatCtx = '\n\n## CONTEXTE BATEAU DU CLIENT:';
      if (boatContext.type) boatCtx += `\n- Type: ${boatContext.type}`;
      if (boatContext.length) boatCtx += `\n- Longueur: ${boatContext.length}m`;
      if (boatContext.nav) boatCtx += `\n- Navigation: ${boatContext.nav}`;
    }

    const systemPrompt = SYSTEM_PROMPT + productCtx + boatCtx;

    // Build messages (keep last 12 from history + current message)
    const messages = [
      ...history.slice(-12).map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : ''
      })),
      { role: 'user', content: message }
    ];

    // Call Claude
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    const reply = response.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('');

    res.json({
      reply,
      products: results.slice(0, 6).map(r => ({
        ref: r.ref,
        desc: r.desc,
        prix: r.prix,
        url: `https://omaxmarine.fr/?s=${encodeURIComponent(r.desc)}&post_type=product`
      })),
    });

  } catch (err) {
    console.error('Erreur API:', err.message);
    
    // Fallback: return products even if Claude API fails
    const results = searchCatalogue(req.body?.message || '');
    
    res.status(500).json({
      error: 'Service temporairement indisponible',
      reply: results.length > 0
        ? `Voici ce que j'ai trouvé dans notre catalogue. Pour un conseil personnalisé, contactez-nous au 04 93 45 72 04 ⚓`
        : `Notre service est temporairement indisponible. Contactez-nous au 04 93 45 72 04 ou omaxmarine@gmail.com ⚓`,
      products: results.slice(0, 6).map(r => ({
        ref: r.ref,
        desc: r.desc,
        prix: r.prix,
        url: `https://omaxmarine.fr/?s=${encodeURIComponent(r.desc)}&post_type=product`
      })),
    });
  }
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`⚓ OMAX MARINE Chatbot API`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Produits: ${catalogue.length}`);
  console.log(`   CORS: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`   Rate limit: ${RATE_PER_MIN}/min`);
  console.log(`   → http://localhost:${PORT}/api/health`);
});
