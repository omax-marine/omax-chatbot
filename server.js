/**
 * OMAX MARINE — Chatbot Backend API v2 PREMIUM
 * Distributeur officiel Osculati France · Le Cannet (06)
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
try { const sdk = require('@anthropic-ai/sdk'); Anthropic = sdk.default || sdk.Anthropic || sdk; }
catch (e) { console.error('ERREUR SDK:', e.message); process.exit(1); }
const anthropic = new Anthropic({ apiKey: API_KEY });

let catalogue = [];
try { catalogue = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalogue.json'), 'utf-8')); console.log('Catalogue: ' + catalogue.length + ' produits'); }
catch (e) { console.error('Erreur catalogue:', e.message); }

function norm(s) { return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' '); }
const STOP = new Set(['les','des','une','est','que','pour','dans','avec','sur','par','pas','plus','tout','vous','avez','cette','quel','quelle','comment','bonjour','merci','salut','cherche','voudrais','besoin','prix','combien','coute','aide','pouvez','mon','mes','votre','nos','fait','faire','faut','peut','sont','ont','veux','avoir','aussi','tres','bien','oui','non','bon','bonne','jai','cest','bateau','boat']);

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

var URGENT = ['panne','urgence','urgent','sos','voie d eau','voie deau','plus de batterie','plus de courant','pompe hs','moteur hs','coule','fuite','secours','detresse','batterie morte','plus rien','au secours','panne moteur'];
function isUrgent(msg) { var ml = norm(msg); return URGENT.some(function(kw) { return ml.indexOf(kw) !== -1; }); }

function detectStage(msg, hist, bc) {
  var ml = msg.toLowerCase();
  if (/commander|acheter|panier|devis|whatsapp|telephone|appeler|prix final/i.test(ml)) return 'closing';
  if (/compar|difference|entre.*et|lequel|laquelle|mieux|versus|vs\b/i.test(ml)) return 'comparison';
  if ((bc.boatType || bc.length) && hist.length >= 3) return 'recommendation';
  if (hist.length >= 1) return 'qualification';
  return 'discovery';
}

var SYSTEM_PROMPT = 'You are an elite marine equipment advisor working for OMAX MARINE, premium nautical supply company and official Osculati France distributor based in Le Cannet (06110), France.\n\nALWAYS respond in French. ALWAYS.\n\n## YOUR IDENTITY\nYou are NOT a generic AI or product search engine. You are a real yacht outfitting specialist.\n\n## CONVERSATION STAGES\n\n### DISCOVERY\nWelcome warmly. Ask 1-2 smart questions max. Sound like a knowledgeable friend.\n\n### QUALIFICATION\nGather missing info (boat type, length, usage, area). Acknowledge what they said. Max 2 questions.\n\n### RECOMMENDATION\nRecommend 2-3 products explaining WHY each fits. Reference their boat. Show budget vs premium.\n\n### COMPARISON\nGive honest pros/cons. Recommend best for THEIR situation.\n\n### CLOSING\nConfirm recommendation. Suggest WhatsApp: 06 03 68 84 54 or Tel: 04 93 45 72 04 for devis.\n\n## URGENCY MODE\nIf EMERGENCY: skip qualification, give immediate advice, show Tel: 04 93 45 72 04 and WhatsApp: 06 03 68 84 54 prominently. Be calm and solution-focused.\n\n## SIZING RULES\n\n### Ancres\n< 6m: 5-8kg | 6-8m: 8-12kg | 8-10m: 12-16kg | 10-12m: 16-20kg | 12-15m: 20-30kg | >15m: 30-50kg\nVoilier = +20% | Sable: Delta/DTX | Rocheux: Trefoil | Mixte: Fortress\n\n### Chaine\nDiametre = longueur/1.5 arrondi sup | Longueur = 3-5x profondeur\n<8m: 6-8mm | 8-12m: 8-10mm | >12m: 10-12mm\n\n### Pare-battage\nDiametre = 2cm/m de bateau | Min 3/cote\n\n### Pompe de cale\n<7m: 500-1000 GPH | 7-12m: 1500-2500 GPH | >12m: 3000+ GPH\n\n### Gilets\nCotier: 100N | Hauturier: 150N | Pro: 275N | Enfants <30kg: obligatoire\n\n### Guindeau\nPuissance = poids mouillage x3 | <10m: 500-700W | 10-14m: 700-1500W | >14m: 1500W+\n\n## FORMAT\n- Concis: 2-4 phrases + produits\n- Utiliser ▸ pour les produits\n- Max 5 produits\n- Expliquer POURQUOI chaque produit\n- Mentionner budget vs premium\n\n## REGLES\n- JAMAIS inventer references ou prix\n- Seuls les produits du catalogue fourni\n- Si rien trouve: orienter vers Tel 04 93 45 72 04\n- Client pret a acheter: suggerer WhatsApp 06 03 68 84 54\n- Jamais agressif ou pushy\n- Priorite: securite > compatibilite > fiabilite > prix\n\n## INFOS OMAX\nTel: 04 93 45 72 04 | WhatsApp: 06 03 68 84 54\nEmail: omaxmarine@gmail.com\n11-13 chemin de l\'industrie, 06110 Le Cannet\nomaxmarine.fr | 24000+ ref Osculati | Livraison ~1 semaine';

var app = express();
app.use(helmet());
app.use(express.json({ limit: '16kb' }));
app.use(cors({
  origin: function(origin, cb) { if (!origin || ALLOWED_ORIGINS.indexOf(origin) !== -1) cb(null, true); else cb(new Error('CORS')); },
  methods: ['POST', 'GET'], allowedHeaders: ['Content-Type'],
}));
app.use('/api/', rateLimit({ windowMs: 60000, max: RATE_PER_MIN, message: { error: 'Trop de requetes' }, standardHeaders: true, legacyHeaders: false }));

app.get('/api/health', function(req, res) { res.json({ status: 'ok', products: catalogue.length, version: 'v2' }); });

app.post('/api/chat', async function(req, res) {
  try {
    var body = req.body;
    var message = body.message;
    var history = body.history || [];
    var boatContext = body.boatContext || {};

    if (!message || typeof message !== 'string' || message.length > 2000) return res.status(400).json({ error: 'Message invalide' });

    var urgent = isUrgent(message);
    var stage = body.conversationStage || detectStage(message, history, boatContext);
    var allResults = searchCatalogue(message);
    var results = selectVariety(allResults, 5);

    var ctx = '';
    if (results.length > 0) {
      ctx += '\n\n## PRODUITS CATALOGUE:\n' + results.map(function(r) { return '- ' + r.desc + ' | Ref: ' + r.ref + ' | ' + r.prix.toFixed(2) + ' EUR'; }).join('\n');
    }

    var bc = boatContext;
    if (bc.boatType || bc.length || bc.brand || bc.navigationArea || bc.currentNeed) {
      ctx += '\n\n## PROFIL CLIENT:';
      if (bc.boatType) ctx += '\n- Type: ' + bc.boatType;
      if (bc.brand) ctx += '\n- Marque: ' + bc.brand;
      if (bc.model) ctx += '\n- Modele: ' + bc.model;
      if (bc.length) ctx += '\n- Longueur: ' + bc.length + 'm';
      if (bc.engineType) ctx += '\n- Moteur: ' + bc.engineType;
      if (bc.navigationArea) ctx += '\n- Zone: ' + bc.navigationArea;
      if (bc.navigationType) ctx += '\n- Nav: ' + bc.navigationType;
      if (bc.usage) ctx += '\n- Usage: ' + bc.usage;
      if (bc.experienceLevel) ctx += '\n- Niveau: ' + bc.experienceLevel;
      if (bc.budgetLevel) ctx += '\n- Budget: ' + bc.budgetLevel;
      if (bc.currentNeed) ctx += '\n- Besoin: ' + bc.currentNeed;
    }

    ctx += '\n\n## STAGE: ' + stage.toUpperCase();
    if (urgent) ctx += '\n## *** URGENCE *** Protocole urgence actif.';

    var msgs = history.slice(-14).map(function(m) { return { role: m.role, content: typeof m.content === 'string' ? m.content : '' }; });
    msgs.push({ role: 'user', content: message });

    var response = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, system: SYSTEM_PROMPT + ctx, messages: msgs });
    var reply = response.content.filter(function(c) { return c.type === 'text'; }).map(function(c) { return c.text; }).join('');

    res.json({
      reply: reply,
      products: results.map(function(r) { return { ref: r.ref, desc: r.desc, prix: r.prix, url: 'https://omaxmarine.fr/?s=' + encodeURIComponent(r.desc) + '&post_type=product' }; }),
      stage: stage,
      isUrgent: urgent,
    });
  } catch (err) {
    console.error('Erreur:', err.message);
    var results2 = selectVariety(searchCatalogue(req.body && req.body.message || ''), 5);
    res.status(500).json({
      reply: results2.length > 0 ? 'Voici nos produits. Pour un conseil, appelez le 04 93 45 72 04 ou WhatsApp 06 03 68 84 54' : 'Service indisponible. Appelez le 04 93 45 72 04 ou WhatsApp 06 03 68 84 54',
      products: results2.map(function(r) { return { ref: r.ref, desc: r.desc, prix: r.prix, url: 'https://omaxmarine.fr/?s=' + encodeURIComponent(r.desc) + '&post_type=product' }; }),
      stage: 'closing', isUrgent: isUrgent(req.body && req.body.message || ''),
    });
  }
});

app.post('/api/lead', function(req, res) {
  var b = req.body || {};
  if (!b.name && !b.email && !b.phone) return res.status(400).json({ error: 'Infos manquantes' });
  console.log('=== LEAD === ' + new Date().toISOString());
  console.log('Nom: ' + (b.name||'-') + ' | Email: ' + (b.email||'-') + ' | Tel: ' + (b.phone||'-'));
  console.log('Bateau: ' + (b.boat||'-') + ' | Besoin: ' + (b.need||'-') + ' | Canal: ' + (b.channel||'-'));
  res.json({ success: true, message: 'Merci ! Notre equipe vous contactera rapidement.' });
});

app.listen(PORT, function() {
  console.log('OMAX MARINE Chatbot API v2');
  console.log('  Port: ' + PORT + ' | Produits: ' + catalogue.length + ' | CORS: ' + ALLOWED_ORIGINS.join(', '));
});
