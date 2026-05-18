/**
 * OMAX MARINE — Chatbot Backend API v4
 * 7 stages + natural expert conversation
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

var Anthropic;
try { var sdk = require('@anthropic-ai/sdk'); Anthropic = sdk.default || sdk.Anthropic || sdk; }
catch (e) { console.error('ERREUR SDK:', e.message); process.exit(1); }
var anthropic = new Anthropic({ apiKey: API_KEY });

var catalogue = [];
try { catalogue = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalogue.json'), 'utf-8')); console.log('Catalogue: ' + catalogue.length + ' produits'); }
catch (e) { console.error('Erreur catalogue:', e.message); }

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

var URGENT = ['panne','urgence','urgent','sos','voie d eau','voie deau','plus de batterie','plus de courant','pompe hs','moteur hs','coule','fuite','secours','detresse','batterie morte','plus rien','au secours','panne moteur','casse','incendie','feu a bord'];
function isUrgent(msg) { var ml = norm(msg); return URGENT.some(function(kw) { return ml.indexOf(kw) !== -1; }); }

// ── 7-Stage Detection — faster progression ──
function detectStage(msg, hist, bc) {
  var ml = msg.toLowerCase();
  var msgCount = hist.length;

  if (/parler.*humain|parler.*quelqu|vrai.*personne|rappel|etre rappele|un conseiller|un technicien|trop complique|je comprends pas/i.test(ml)) return 'handoff';
  if (/commander|acheter|panier|devis|whatsapp|telephone|appeler|prix final|je prends|on y va|c.est bon|parfait.*prends/i.test(ml)) return 'closing';
  if (/compar|difference|entre.*et|lequel|laquelle|mieux|versus|vs\b|plutot|prefere/i.test(ml)) return 'comparison';

  // FASTER: recommend after 3 exchanges if we have boat type + need
  if (bc.boatType && bc.currentNeed && msgCount >= 3) return 'recommendation';
  // Or after 5 exchanges no matter what
  if (msgCount >= 5 && bc.currentNeed) return 'recommendation';

  // Diagnostic: boat + length known
  if (bc.boatType && bc.length && bc.currentNeed && msgCount >= 2) return 'diagnostic';

  if (msgCount >= 1 && (bc.boatType || bc.length || bc.currentNeed)) return 'qualification';
  return 'discovery';
}

// ── System Prompt v4 — Natural Expert ──
var SYSTEM_PROMPT = 'Tu es un conseiller nautique expert chez OMAX MARINE, distributeur officiel Osculati France au Cannet (06110).\n\
\n\
## QUI TU ES\n\
Tu es un VRAI shipchandler passionne, pas un chatbot generique. Tu connais les bateaux, les contraintes reelles, tu parles d\'experience.\n\
\n\
## COMMENT TU PARLES\n\
- Comme un pote expert au comptoir d\'un shipchandler, pas comme un formulaire\n\
- UNE question principale a la fois, parfois une petite secondaire glissee naturellement\n\
- JAMAIS de listes numerotees (1. 2. 3.) pour poser des questions\n\
- JAMAIS plus de 2 questions par message\n\
- Reponses COURTES : 2-3 phrases max en qualification, 3-4 en diagnostic/recommendation\n\
- Tu donnes ton AVIS : "Honnetement, pour votre config je partirais sur..." / "Entre nous, le premium vaut le coup si..."\n\
- Tu reagis naturellement : "Bonne config pour du lac ! 👍" / "Un 10m, ca commence a etre du serieux ⚓"\n\
- Tu RESUMES ce que tu as compris quand tu as assez d\'infos : "Donc si je resume : semi-rigide 8m, lac, amarrage quai ✔"\n\
\n\
## 7 STAGES — SUIS-LES STRICTEMENT\n\
\n\
### 1. DISCOVERY\n\
Premier contact. Accueil chaleureux + une question sur le bateau ou le besoin.\n\
*** ZERO produit. Juste accueillir et comprendre. ***\n\
\n\
### 2. QUALIFICATION\n\
Pose UNIQUEMENT les infos manquantes. Si tu connais deja le type, ne le redemande pas.\n\
Questions a poser (seulement celles qui manquent) :\n\
- Type de bateau (si pas encore connu)\n\
- Longueur approximative (si pas connue)\n\
- Zone de navigation (si pertinent)\n\
- Le besoin specifique (si pas clair)\n\
*** ZERO produit. UNE question a la fois. Max 2-3 echanges de qualification. ***\n\
\n\
### 3. DIAGNOSTIC\n\
Tu as assez d\'infos. Fais ton analyse technique COURTE :\n\
- Applique les regles de dimensionnement\n\
- Resume en 2-3 phrases ce qu\'il faut\n\
- Demande si le client veut voir les options\n\
*** PAS ENCORE de cartes produits. Juste l\'analyse. ***\n\
\n\
### 4. RECOMMENDATION\n\
MAINTENANT tu montres les produits.\n\
- 3-5 produits avec variete de prix (entree de gamme → premium)\n\
- Explique POURQUOI chaque option en 1 phrase\n\
- Donne ton avis : "Perso, pour votre usage je recommande le milieu de gamme"\n\
\n\
### 5. COMPARISON\n\
Le client compare. Pros/cons honnetes. Recommande le meilleur pour SA situation.\n\
\n\
### 6. CLOSING\n\
Client pret. Confirme + propose : WhatsApp 06 03 68 84 54 / Tel 04 93 45 72 04 / devis.\n\
\n\
### 7. HANDOFF\n\
Client veut un humain. Resume la conversation + donne tous les contacts.\n\
\n\
## REGLE CRITIQUE : VITESSE\n\
Apres 3-5 echanges MAX, tu dois commencer a recommander. Meme si t\'as pas tout.\n\
Mieux vaut recommander avec 80% d\'info que de poser 10 questions.\n\
Si le client donne le bateau + la longueur + le besoin, passe DIRECTEMENT au diagnostic.\n\
\n\
## URGENCE\n\
Panne/SOS : skip tout. Conseil immediat + Tel 04 93 45 72 04 + WhatsApp 06 03 68 84 54.\n\
\n\
## DIMENSIONNEMENT\n\
\n\
Ancres : <6m:5-8kg | 6-8m:8-12kg | 8-10m:12-16kg | 10-12m:16-20kg | 12-15m:20-30kg | >15m:30-50kg. Voilier +20%.\n\
Chaine : diametre = longueur/1.5 arrondi sup. <8m:6-8mm | 8-12m:8-10mm | >12m:10-12mm.\n\
Pare-battage : diametre = 2cm/m de bateau. Min 3/cote.\n\
Pompe de cale : <7m:500-1000GPH | 7-12m:1500-2500GPH | >12m:3000+GPH.\n\
Gilets : cotier:100N | hauturier:150N-275N | enfants<30kg:obligatoire.\n\
Guindeau : puissance = poids mouillage x3. <10m:500-700W | 10-14m:700-1500W | >14m:1500W+.\n\
\n\
## FORMAT\n\
- Utiliser ▸ pour lister les produits (uniquement en recommendation/comparison/closing)\n\
- ** pour les mots importants\n\
- Max 5 produits\n\
- JAMAIS inventer references ou prix\n\
- JAMAIS inventer de noms de personnes ou d\'employes. Ne mentionne AUCUN prenom. Dis "notre equipe", "nos conseillers", "un expert OMAX".\n\
- Si rien trouve : orienter vers Tel 04 93 45 72 04\n\
\n\
## INFOS OMAX\n\
Tel: 04 93 45 72 04 | WhatsApp: 06 03 68 84 54 | omaxmarine@gmail.com\n\
11-13 chemin de l\'industrie, 06110 Le Cannet | omaxmarine.fr | 24000+ ref Osculati | Livraison ~1 semaine';

// ── Express ──
var app = express();
app.use(helmet());
app.use(express.json({ limit: '16kb' }));
app.use(cors({
  origin: function(origin, cb) { if (!origin || ALLOWED_ORIGINS.indexOf(origin) !== -1) cb(null, true); else cb(new Error('CORS')); },
  methods: ['POST', 'GET'], allowedHeaders: ['Content-Type'],
}));
app.use('/api/', rateLimit({ windowMs: 60000, max: RATE_PER_MIN, message: { error: 'Trop de requetes' }, standardHeaders: true, legacyHeaders: false }));

app.get('/api/health', function(req, res) { res.json({ status: 'ok', products: catalogue.length, version: 'v4' }); });

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
      var searchQuery = message;
      if (boatContext.currentNeed) searchQuery += ' ' + boatContext.currentNeed;
      results = selectVariety(searchCatalogue(searchQuery), 5);
    }

    var ctx = '';

    if (results.length > 0) {
      ctx += '\n\n## PRODUITS DISPONIBLES (propose les plus pertinents):\n' + results.map(function(r) { return '- ' + r.desc + ' | Ref: ' + r.ref + ' | ' + r.prix.toFixed(2) + ' EUR'; }).join('\n');
    }

    if (!showProducts && !urgent) {
      ctx += '\n\n## INSTRUCTION: Stage ' + stage.toUpperCase() + '. NE MENTIONNE AUCUN produit, reference ou prix. Pose uniquement des questions ou fais ton diagnostic.';
    }

    // Boat context — tell Claude what's already known so it doesn't re-ask
    var bc = boatContext;
    var knownFields = [];
    if (bc.boatType) knownFields.push('Type: ' + bc.boatType);
    if (bc.brand) knownFields.push('Marque: ' + bc.brand);
    if (bc.model) knownFields.push('Modele: ' + bc.model);
    if (bc.length) knownFields.push('Longueur: ' + bc.length + 'm');
    if (bc.engineType) knownFields.push('Moteur: ' + bc.engineType);
    if (bc.navigationArea) knownFields.push('Zone: ' + bc.navigationArea);
    if (bc.navigationType) knownFields.push('Navigation: ' + bc.navigationType);
    if (bc.usage) knownFields.push('Usage: ' + bc.usage);
    if (bc.budgetLevel) knownFields.push('Budget: ' + bc.budgetLevel);
    if (bc.currentNeed) knownFields.push('Besoin: ' + bc.currentNeed);

    if (knownFields.length > 0) {
      ctx += '\n\n## CE QUE TU SAIS DEJA DU CLIENT (ne redemande PAS ces infos):\n' + knownFields.map(function(f) { return '✔ ' + f; }).join('\n');

      // Tell Claude what's missing
      var missing = [];
      if (!bc.boatType) missing.push('type de bateau');
      if (!bc.length) missing.push('longueur');
      if (!bc.currentNeed) missing.push('besoin principal');
      if (missing.length > 0 && (stage === 'qualification' || stage === 'discovery')) {
        ctx += '\n\n## INFOS MANQUANTES (pose ces questions si pertinent): ' + missing.join(', ');
      }
    }

    ctx += '\n\n## STAGE ACTUEL: ' + stage.toUpperCase();
    ctx += '\n## NOMBRE ECHANGES: ' + history.length;
    if (history.length >= 4 && !showProducts) {
      ctx += '\n## ATTENTION: ' + history.length + ' echanges deja. Accelere vers le diagnostic/recommendation. Le client attend de la valeur concrete.';
    }
    if (urgent) ctx += '\n## *** URGENCE *** Protocole urgence. Ignore les stages.';

    var msgs = history.slice(-14).map(function(m) { return { role: m.role, content: typeof m.content === 'string' ? m.content : '' }; });
    msgs.push({ role: 'user', content: message });

    var response = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 800, system: SYSTEM_PROMPT + ctx, messages: msgs });
    var reply = response.content.filter(function(c) { return c.type === 'text'; }).map(function(c) { return c.text; }).join('');

    res.json({
      reply: reply,
      products: showProducts ? results.map(function(r) { return { ref: r.ref, desc: r.desc, prix: r.prix, url: 'https://omaxmarine.fr/?s=' + encodeURIComponent(r.desc) + '&post_type=product' }; }) : [],
      stage: stage,
      isUrgent: urgent,
    });
  } catch (err) {
    console.error('Erreur:', err.message);
    res.status(500).json({
      reply: 'Petit souci technique de mon cote. Contactez-nous directement :\n\n▸ **Tel** : 04 93 45 72 04\n▸ **WhatsApp** : 06 03 68 84 54\n\nNotre equipe sera ravie de vous aider ! ⚓',
      products: [],
      stage: 'handoff',
      isUrgent: false,
    });
  }
});

app.post('/api/lead', function(req, res) {
  var b = req.body || {};
  if (!b.name && !b.email && !b.phone) return res.status(400).json({ error: 'Infos manquantes' });
  console.log('=== LEAD === ' + new Date().toISOString());
  console.log('Nom: ' + (b.name||'-') + ' | Email: ' + (b.email||'-') + ' | Tel: ' + (b.phone||'-'));
  console.log('Bateau: ' + (b.boat||'-') + ' | Besoin: ' + (b.need||'-'));
  res.json({ success: true, message: 'Merci ! Notre equipe vous contactera rapidement.' });
});

app.listen(PORT, function() {
  console.log('OMAX MARINE Chatbot API v4');
  console.log('  Port: ' + PORT + ' | Produits: ' + catalogue.length + ' | CORS: ' + ALLOWED_ORIGINS.join(', '));
});
