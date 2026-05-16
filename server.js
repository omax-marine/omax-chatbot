/**
 * OMAX MARINE — Chatbot Backend API v3
 * 7-stage conversation flow
 * Discovery → Qualification → Diagnostic → Recommendation → Comparison → Closing → Handoff
 */
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

require('./load-env');

const PORT = process.env.PORT || 3456;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://omaxmarine.fr').split(',').map(s => s.trim());
const RATE_PER_MIN = parseInt(process.env.RATE_LIMIT_PER_MINUTE || '15');

if (!API_KEY || API_KEY.includes('VOTRE_CLE')) { console.error('ERREUR: Configurez ANTHROPIC_API_KEY'); process.exit(1); }

let Anthropic;
try { var sdk = require('@anthropic-ai/sdk'); Anthropic = sdk.default || sdk.Anthropic || sdk; }
catch (e) { console.error('ERREUR SDK:', e.message); process.exit(1); }
var anthropic = new Anthropic({ apiKey: API_KEY });

var catalogue = [];
try { catalogue = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalogue.json'), 'utf-8')); console.log('Catalogue: ' + catalogue.length + ' produits'); }
catch (e) { console.error('Erreur catalogue:', e.message); }

// ── Search ──
function norm(s) { return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' '); }
var STOP = new Set(['les','des','une','est','que','pour','dans','avec','sur','par','pas','plus','tout','vous','avez','cette','quel','quelle','comment','bonjour','merci','salut','cherche','voudrais','besoin','prix','combien','coute','aide','pouvez','mon','mes','votre','nos','fait','faire','faut','peut','sont','ont','veux','avoir','aussi','tres','bien','oui','non','bon','bonne','jai','cest','bateau','boat']);

function searchCatalogue(query) {
  var terms = norm(query).split(/\s+/).filter(function(t) { return t.length > 1 && !STOP.has(t); });
  if (!terms.length) return [];
  var scored = [];
  for (var i = 0; i < catalogue.length; i++) {
    var ref = catalogue[i][0], desc = catalogue[i][1], prix = catalogue[i][2];
    if (!prix || isNaN(prix)) continue;
    var dn = norm(desc), rn = norm(ref), sc = 0, m = 0;
    for (var j = 0; j < terms.length; j++) {
      var t = terms[j];
      if (dn.indexOf(t) !== -1) { sc += 3; m++; }
      else if (rn.indexOf(t) !== -1) { sc += 2; m++; }
      else if (t.length >= 4 && dn.indexOf(t.slice(0, 4)) !== -1) { sc += 1; m++; }
    }
    if (m === terms.length && terms.length > 1) sc += 5;
    if (sc > 0) scored.push({ ref: ref, desc: desc, prix: prix, sc: sc });
  }
  scored.sort(function(a, b) { return b.sc - a.sc; });
  return scored.slice(0, 20);
}

function selectVariety(products, max) {
  if (products.length <= max) return products;
  products.sort(function(a, b) { return a.prix - b.prix; });
  var step = (products.length - 1) / (max - 1);
  var picked = [];
  for (var i = 0; i < max; i++) picked.push(products[Math.round(i * step)]);
  return picked;
}

// ── Urgency ──
var URGENT = ['panne','urgence','urgent','sos','voie d eau','voie deau','plus de batterie','plus de courant','pompe hs','moteur hs','coule','fuite','secours','detresse','batterie morte','plus rien','au secours','panne moteur','casse','explose','flamme','feu a bord','incendie'];
function isUrgent(msg) { var ml = norm(msg); return URGENT.some(function(kw) { return ml.indexOf(kw) !== -1; }); }

// ── 7-Stage Detection ──
function detectStage(msg, hist, bc) {
  var ml = msg.toLowerCase();
  var msgCount = hist.length;

  // Handoff: client demande explicitement un humain
  if (/parler.*humain|parler.*quelqu|vrai.*personne|rappel|etre rappele|un conseiller|un technicien|trop complique|je comprends pas/i.test(ml)) return 'handoff';

  // Closing: client pret a acheter
  if (/commander|acheter|panier|devis|whatsapp|telephone|appeler|prix final|je prends|on y va|c.est bon|parfait.*prends/i.test(ml)) return 'closing';

  // Comparison: client compare
  if (/compar|difference|entre.*et|lequel|laquelle|mieux|versus|vs\b|plutot|prefere/i.test(ml)) return 'comparison';

  // Recommendation: on a le bateau + longueur + besoin ET assez de messages
  if (bc.boatType && bc.length && bc.currentNeed && msgCount >= 4) return 'recommendation';

  // Diagnostic: on a le bateau + longueur, on analyse le besoin technique
  if (bc.boatType && bc.length && msgCount >= 2) return 'diagnostic';

  // Qualification: on a au moins une info
  if (msgCount >= 1 && (bc.boatType || bc.length || bc.currentNeed)) return 'qualification';

  // Discovery: debut de conversation
  return 'discovery';
}

// ── System Prompt v3 ──
var SYSTEM_PROMPT = 'You are an elite marine equipment advisor for OMAX MARINE, official Osculati France distributor in Le Cannet (06110), France.\n\
\n\
ALWAYS respond in French. ALWAYS.\n\
\n\
## IDENTITY\n\
You are a real yacht outfitting specialist, NOT a product search engine.\n\
You have deep expertise in: marine equipment, yacht systems, navigation, safety, anchoring, electrical systems, maintenance, Mediterranean and tropical environments.\n\
\n\
## 7-STAGE CONVERSATION FLOW\n\
Follow these stages strictly. NEVER skip stages.\n\
\n\
### 1. DISCOVERY\n\
First contact. Welcome warmly.\n\
- Ask what they need or what boat they have\n\
- Max 1-2 questions\n\
- Sound like a knowledgeable friend\n\
- *** ZERO PRODUCTS. Do NOT mention any product, reference, or price ***\n\
\n\
### 2. QUALIFICATION\n\
Gather essential info you are still missing:\n\
- Boat type (voilier, moteur, catamaran...)\n\
- Boat length\n\
- Navigation area (cotier, hauturier, Mediterranee...)\n\
- Current equipment already installed\n\
- Max 2 questions per message\n\
- Acknowledge what the client already told you\n\
- *** ZERO PRODUCTS. Only questions. ***\n\
\n\
### 3. DIAGNOSTIC\n\
You have boat info. Now analyze the TECHNICAL need:\n\
- Apply sizing rules to determine what they need\n\
- Explain your reasoning (why this size, this type, this capacity)\n\
- Validate with the client: "Voici ce que je recommande pour votre configuration..."\n\
- Ask if they want to see the options\n\
- *** NO PRODUCT CARDS YET. Only technical analysis and explanation. ***\n\
\n\
### 4. RECOMMENDATION\n\
NOW show products. Only at this stage.\n\
- Recommend 3-5 products with price variety (budget, milieu de gamme, premium)\n\
- Explain WHY each product fits their boat\n\
- Reference their specific boat type and length\n\
- Mention trade-offs (prix vs qualite, installation, durabilite)\n\
\n\
### 5. COMPARISON (if needed)\n\
Client is comparing options:\n\
- Give honest pros/cons\n\
- Recommend the best option for THEIR specific situation\n\
- Do not oversell\n\
\n\
### 6. CLOSING\n\
Client is ready to act:\n\
- Confirm the recommendation\n\
- Suggest contacting for a devis personnalise\n\
- Mention: WhatsApp 06 03 68 84 54 / Tel 04 93 45 72 04\n\
- Offer to add to cart on omaxmarine.fr\n\
\n\
### 7. HANDOFF\n\
Client wants a real human or the request is too complex:\n\
- Acknowledge their need warmly\n\
- Provide all contact options:\n\
  Tel: 04 93 45 72 04\n\
  WhatsApp: 06 03 68 84 54\n\
  Email: omaxmarine@gmail.com\n\
- Summarize what was discussed so the human advisor has context\n\
- Say: "Notre equipe sera ravie de prendre le relais"\n\
\n\
## URGENCY MODE\n\
If EMERGENCY (panne, voie d eau, SOS):\n\
- Skip ALL stages\n\
- Give immediate practical safety advice\n\
- Show Tel: 04 93 45 72 04 and WhatsApp: 06 03 68 84 54 prominently\n\
- Be calm, reassuring, solution-focused\n\
- Recommend emergency products immediately if available\n\
\n\
## SIZING RULES\n\
\n\
### Ancres\n\
< 6m: 5-8kg | 6-8m: 8-12kg | 8-10m: 12-16kg | 10-12m: 16-20kg | 12-15m: 20-30kg | >15m: 30-50kg\n\
Voilier = +20% poids (prise au vent)\n\
Sable/vase: Delta, DTX, CQR | Rocheux: Trefoil, grappin | Mixte: Fortress, Bruce | Herbes: Danforth\n\
\n\
### Chaine\n\
Diametre = longueur(m) / 1.5 arrondi sup | Longueur = 3-5x profondeur max\n\
<8m: 6-8mm | 8-12m: 8-10mm | >12m: 10-12mm\n\
\n\
### Pare-battage\n\
Diametre = 2cm par metre de bateau | Min 3 par cote | Longueur = 2x diametre\n\
\n\
### Pompe de cale\n\
<7m: 500-1000 GPH | 7-12m: 1500-2500 GPH | >12m: 3000+ GPH\n\
Toujours: 1 automatique + 1 manuelle de secours\n\
\n\
### Gilets\n\
Cotier <6 milles: 100N | Semi-hauturier: 150N | Hauturier: 150N-275N | Enfants <30kg: obligatoire\n\
\n\
### Guindeau\n\
Puissance = poids mouillage total x 3\n\
<10m: 500-700W | 10-14m: 700-1500W | >14m: 1500W+\n\
\n\
### Batteries\n\
Demarrage: AGM | Servitude: AGM Deep Cycle ou Lithium\n\
Capacite = conso journaliere x3 (AGM) ou x1.5 (Lithium)\n\
\n\
### Panneaux solaires\n\
100W par tranche de 100Ah de batterie servitude\n\
Flexible: leger, moins durable | Rigide: plus efficace\n\
\n\
## RESPONSE FORMAT\n\
- Concis: 2-4 phrases maximum\n\
- Use ▸ for product listings (only in recommendation/comparison/closing)\n\
- Use ** for emphasis\n\
- Max 5 products when showing products\n\
- NEVER list products in discovery, qualification, or diagnostic stages\n\
\n\
## CRITICAL RULES\n\
- NEVER invent references, prices, stock, or URLs\n\
- ONLY use products from the provided catalogue data\n\
- If no product found: orient to Tel 04 93 45 72 04\n\
- NEVER be pushy or aggressive\n\
- Priority: safety > compatibility > reliability > price\n\
\n\
## COMPANY INFO\n\
Tel: 04 93 45 72 04 | WhatsApp: 06 03 68 84 54\n\
Email: omaxmarine@gmail.com\n\
11-13 chemin de l\'industrie, 06110 Le Cannet\n\
omaxmarine.fr | 24000+ ref Osculati | Livraison ~1 semaine';

// ── Express ──
var app = express();
app.use(helmet());
app.use(express.json({ limit: '16kb' }));
app.use(cors({
  origin: function(origin, cb) { if (!origin || ALLOWED_ORIGINS.indexOf(origin) !== -1) cb(null, true); else cb(new Error('CORS')); },
  methods: ['POST', 'GET'], allowedHeaders: ['Content-Type'],
}));
app.use('/api/', rateLimit({ windowMs: 60000, max: RATE_PER_MIN, message: { error: 'Trop de requetes' }, standardHeaders: true, legacyHeaders: false }));

app.get('/api/health', function(req, res) { res.json({ status: 'ok', products: catalogue.length, version: 'v3' }); });

// ── Chat ──
app.post('/api/chat', async function(req, res) {
  try {
    var body = req.body;
    var message = body.message;
    var history = body.history || [];
    var boatContext = body.boatContext || {};

    if (!message || typeof message !== 'string' || message.length > 2000) return res.status(400).json({ error: 'Message invalide' });

    var urgent = isUrgent(message);
    var stage = body.conversationStage || detectStage(message, history, boatContext);

    // Products ONLY in recommendation, comparison, closing, or urgency
    var showProducts = urgent || stage === 'recommendation' || stage === 'comparison' || stage === 'closing';
    var results = [];
    if (showProducts) {
      // Search using current message + currentNeed for better results
      var searchQuery = message;
      if (boatContext.currentNeed) searchQuery += ' ' + boatContext.currentNeed;
      results = selectVariety(searchCatalogue(searchQuery), 5);
    }

    // Build context
    var ctx = '';

    // Products context for Claude (only when showing)
    if (results.length > 0) {
      ctx += '\n\n## PRODUITS DISPONIBLES (propose les plus pertinents au client):\n' + results.map(function(r) { return '- ' + r.desc + ' | Ref: ' + r.ref + ' | ' + r.prix.toFixed(2) + ' EUR'; }).join('\n');
    }

    // No-product instruction for early stages
    if (!showProducts && !urgent) {
      ctx += '\n\n## INSTRUCTION STRICTE: Tu es en stage ' + stage.toUpperCase() + '. NE MENTIONNE AUCUN produit, aucune reference, aucun prix. Pose uniquement des questions pour comprendre le besoin. Si tu mentionnes un produit, c\'est une erreur grave.';
    }

    // Boat context
    var bc = boatContext;
    if (bc.boatType || bc.length || bc.brand || bc.navigationArea || bc.currentNeed) {
      ctx += '\n\n## PROFIL CLIENT:';
      if (bc.boatType) ctx += '\n- Type: ' + bc.boatType;
      if (bc.brand) ctx += '\n- Marque: ' + bc.brand;
      if (bc.model) ctx += '\n- Modele: ' + bc.model;
      if (bc.length) ctx += '\n- Longueur: ' + bc.length + 'm';
      if (bc.engineType) ctx += '\n- Moteur: ' + bc.engineType;
      if (bc.navigationArea) ctx += '\n- Zone: ' + bc.navigationArea;
      if (bc.navigationType) ctx += '\n- Navigation: ' + bc.navigationType;
      if (bc.usage) ctx += '\n- Usage: ' + bc.usage;
      if (bc.experienceLevel) ctx += '\n- Niveau: ' + bc.experienceLevel;
      if (bc.budgetLevel) ctx += '\n- Budget: ' + bc.budgetLevel;
      if (bc.currentNeed) ctx += '\n- Besoin: ' + bc.currentNeed;
    }

    ctx += '\n\n## STAGE ACTUEL: ' + stage.toUpperCase();
    if (urgent) ctx += '\n## *** URGENCE DETECTEE *** Protocole urgence. Ignore les stages.';

    var msgs = history.slice(-14).map(function(m) { return { role: m.role, content: typeof m.content === 'string' ? m.content : '' }; });
    msgs.push({ role: 'user', content: message });

    var response = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, system: SYSTEM_PROMPT + ctx, messages: msgs });
    var reply = response.content.filter(function(c) { return c.type === 'text'; }).map(function(c) { return c.text; }).join('');

    res.json({
      reply: reply,
      products: showProducts ? results.map(function(r) { return { ref: r.ref, desc: r.desc, prix: r.prix, url: 'https://omaxmarine.fr/?s=' + encodeURIComponent(r.desc) + '&post_type=product' }; }) : [],
      stage: stage,
      isUrgent: urgent,
    });
  } catch (err) {
    console.error('Erreur:', err.message);
    var fallbackResults = selectVariety(searchCatalogue(req.body && req.body.message || ''), 5);
    res.status(500).json({
      reply: 'Je rencontre un petit souci technique. Contactez-nous directement pour un conseil personnalise :\n\n▸ **Tel** : 04 93 45 72 04\n▸ **WhatsApp** : 06 03 68 84 54\n▸ **Email** : omaxmarine@gmail.com',
      products: [],
      stage: 'handoff',
      isUrgent: false,
    });
  }
});

// ── Lead Capture ──
app.post('/api/lead', function(req, res) {
  var b = req.body || {};
  if (!b.name && !b.email && !b.phone) return res.status(400).json({ error: 'Infos manquantes' });
  console.log('=== LEAD === ' + new Date().toISOString());
  console.log('Nom: ' + (b.name||'-') + ' | Email: ' + (b.email||'-') + ' | Tel: ' + (b.phone||'-'));
  console.log('Bateau: ' + (b.boat||'-') + ' | Besoin: ' + (b.need||'-'));
  res.json({ success: true, message: 'Merci ! Notre equipe vous contactera rapidement.' });
});

app.listen(PORT, function() {
  console.log('OMAX MARINE Chatbot API v3');
  console.log('  Port: ' + PORT + ' | Produits: ' + catalogue.length + ' | CORS: ' + ALLOWED_ORIGINS.join(', '));
});
