'use strict';
// Decides where a saved link belongs in the reading list.
// Everything here is plain word lists, so the rules are easy to adjust: add a site or a keyword and it takes effect on the next save.

const CATEGORY = {
  physicsPaper: 'Physics papers',
  aiPaper: 'AI / AI safety papers',
  otherPaper: 'Other papers',
  aiPost: 'AI / AI safety blog posts',
  physicsPost: 'Physics posts and articles',
  otherPost: 'Other posts and articles',
  form: 'Forms',
  other: 'Everything else',
};

const PAPER_SITES = ['arxiv.org', 'journals.aps.org', 'link.aps.org', 'inspirehep.net', 'iopscience.iop.org', 'nature.com', 'science.org',
  'sciencedirect.com', 'link.springer.com', 'openreview.net', 'aclanthology.org', 'proceedings.mlr.press', 'proceedings.neurips.cc',
  'papers.nips.cc', 'biorxiv.org', 'semanticscholar.org', 'doi.org', 'scipost.org', 'pnas.org', 'jmlr.org', 'dl.acm.org', 'ieeexplore.ieee.org', 'ssrn.com'];
const POST_SITES = ['lesswrong.com', 'alignmentforum.org', 'substack.com', 'medium.com', 'anthropic.com', 'openai.com', 'deepmind.google',
  'distill.pub', 'transformer-circuits.pub', 'quantamagazine.org', 'aisafety.info', 'effectivealtruism.org', 'forum.effectivealtruism.org',
  'thegradient.pub', 'huggingface.co', 'wordpress.com', 'blogspot.com', 'ghost.io', 'physicsworld.com', 'physics.aps.org'];
const FORM_SITES = ['docs.google.com/forms', 'forms.gle', 'forms.office.com', 'forms.microsoft.com', 'forms.cloud.microsoft', 'typeform.com',
  'surveymonkey.com', 'jotform.com', 'qualtrics.com', 'tally.so', 'formstack.com', 'airtable.com/shr', 'airtable.com/app', 'cognitoforms.com',
  'eventbrite.', 'doodle.com', 'when2meet.com', 'calendly.com', 'docusign.', 'smartsheet.com/b/form'];

const AI_WORDS = ['ai', 'a.i.', 'agi', 'artificial intelligence', 'machine learning', 'deep learning', 'neural network', 'language model', 'llm',
  'transformer', 'reinforcement learning', 'alignment', 'interpretab', 'ai safety', 'superintelligen', 'jailbreak', 'red team', 'red-team',
  'anthropic', 'openai', 'deepmind', 'gpt', 'claude', 'gemini', 'diffusion model', 'fine-tun', 'finetun', 'prompt', 'chatbot', 'generative',
  'existential risk', 'x-risk', 'scheming', 'deceptive', 'sparse autoencoder', 'benchmark', 'evals', 'agentic', 'foundation model'];
const PHYSICS_WORDS = ['quantum', 'gravity', 'gravitation', 'cosmolog', 'black hole', 'string theory', 'field theory', 'particle physics',
  'condensed matter', 'entanglement', 'holograph', 'dark matter', 'dark energy', 'relativity', 'spacetime', 'topological', 'renormali',
  'lattice', 'boson', 'fermion', 'gauge', 'qubit', 'superconduct', 'hamiltonian', 'scattering', 'neutrino', 'inflation', 'thermodynamic',
  'ads/cft', 'supersymmetr', 'physics', 'photon', 'hadron', 'collider', 'gravitational wave', 'tensor network', 'many-body'];

// Topic labels: a label is added when any of its words appears in the title or summary.
const TOPICS = {
  'AI safety': ['ai safety', 'safe ai', 'existential risk', 'x-risk', 'catastrophic risk', 'ai risk', 'misuse', 'safeguard'],
  Alignment: ['alignment', 'misalign', 'scheming', 'deceptive', 'corrigib', 'value learning', 'inner alignment', 'outer alignment'],
  Interpretability: ['interpretab', 'sparse autoencoder', 'circuits', 'feature visuali', 'probing', 'mechanistic'],
  Evaluations: ['evals', 'evaluation', 'benchmark', 'red team', 'red-team', 'jailbreak'],
  'AI governance': ['governance', 'regulation', 'policy', 'compute governance', 'ai act', 'standards'],
  'Language models': ['language model', 'llm', 'gpt', 'claude', 'gemini', 'transformer', 'prompt', 'chatbot'],
  'Reinforcement learning': ['reinforcement learning', 'policy gradient', 'q-learning', 'reward'],
  'Quantum gravity': ['quantum gravity', 'holograph', 'ads/cft', 'loop quantum', 'spin foam', 'causal set', 'emergent spacetime'],
  'Quantum information': ['quantum information', 'qubit', 'entanglement', 'quantum comput', 'quantum error', 'tensor network'],
  'Quantum field theory': ['field theory', 'renormali', 'gauge theor', 'conformal', 'scattering amplitude'],
  'String theory': ['string theory', 'superstring', 'm-theory', 'brane', 'supersymmetr'],
  Cosmology: ['cosmolog', 'inflation', 'dark matter', 'dark energy', 'cmb', 'early universe'],
  'Black holes': ['black hole', 'horizon', 'hawking'],
  'Condensed matter': ['condensed matter', 'superconduct', 'topological', 'many-body', 'lattice model'],
  'Particle physics': ['particle physics', 'collider', 'neutrino', 'hadron', 'standard model', 'higgs'],
  'Gravitational waves': ['gravitational wave', 'ligo', 'binary merger'],
};

// What a form is for.
const FORM_PURPOSES = {
  'Reimbursement / expenses': ['reimburs', 'expense', 'receipt', 'travel claim', 'per diem', 'invoice'],
  'Registration / RSVP': ['regist', 'rsvp', 'sign up', 'sign-up', 'signup', 'attend', 'ticket'],
  Application: ['application', 'apply', 'fellowship', 'grant', 'admission', 'proposal', 'nomination'],
  'Survey / feedback': ['survey', 'feedback', 'questionnaire', 'poll', 'evaluation', 'review form'],
  Scheduling: ['availability', 'schedul', 'doodle', 'when2meet', 'calendly', 'time slot', 'booking'],
  'HR / admin': ['leave', 'vacation', 'payroll', 'tax', 'benefit', 'onboarding', 'timesheet', 'visa', 'immigration'],
  'Consent / agreement': ['consent', 'waiver', 'agreement', 'nda', 'signature', 'docusign'],
  'Request / order': ['request', 'order', 'purchase', 'booking request', 'access request'],
};

const DEADLINE = /\b(deadline|due (by|on|date)|submit by|closes (on|at|in)|closing (date|soon)|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|end of day|eod)|asap|urgent|last (day|chance)|expires?)\b/i;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Short words must match whole (so "ai" does not match "air"); longer ones match as word beginnings ("interpretab…").
const has = (text, word) => new RegExp(`(^|[^a-z0-9])${escapeRe(word)}${word.length <= 5 ? '(s|es)?($|[^a-z0-9])' : ''}`, 'i').test(text);
const score = (title, body, words) => words.reduce((n, w) => n + (has(title, w) ? 2 : 0) + (has(body, w) ? 1 : 0), 0);
const onSite = (target, sites) => sites.some((s) => target.includes(s));

/**
 * item: { url, title, excerpt, arxiv: [categories], isArticle, hasCitation }
 * returns: { category, labels: [..], urgency: 'urgent' | 'soon' | 'whenever' }
 */
function classify(item) {
  const title = String(item.title || '');
  const body = String(item.excerpt || '').slice(0, 6000);
  const text = `${title}\n${body}`;
  let host = '';
  let target = '';
  try {
    const u = new URL(item.url);
    host = u.hostname.replace(/^www\./, '');
    target = host + u.pathname;
  } catch { /* a note without a link */ }

  const arxiv = item.arxiv || [];
  const arxivPhysics = arxiv.some((c) => /^(hep-|gr-qc|quant-ph|astro-ph|cond-mat|nucl-|math-ph|physics|nlin)/.test(c));
  const arxivAi = arxiv.some((c) => /^(cs\.(AI|LG|CL|CV|NE|MA|RO)|stat\.ML)$/.test(c));
  let ai = score(title, body, AI_WORDS) + (arxivAi ? 6 : 0);
  let physics = score(title, body, PHYSICS_WORDS) + (arxivPhysics ? 6 : 0);
  if (arxiv.length && /^(hep-|gr-qc|quant-ph|astro-ph|cond-mat|nucl-|math-ph|physics)/.test(arxiv[0])) physics += 6;
  if (arxiv.length && /^(cs\.(AI|LG|CL)|stat\.ML)$/.test(arxiv[0])) ai += 6;

  const isFormSite = onSite(target, FORM_SITES);
  const isPaper = !isFormSite && (onSite(target, PAPER_SITES) || /\.pdf($|[?#])/i.test(item.url || '') || item.hasCitation || arxiv.length > 0);
  const formTitle = /\b(form|questionnaire|survey|rsvp|registration|sign-?up|application form)\b/i.test(title);
  const isForm = isFormSite || (!isPaper && formTitle && !onSite(target, POST_SITES));
  const isPost = onSite(target, POST_SITES) || item.isArticle || /\/(blog|posts?|news|articles?|p)\//i.test(target) || /^blog\./.test(host);

  let category;
  if (isForm) category = CATEGORY.form;
  else if (isPaper) category = physics > ai ? CATEGORY.physicsPaper : ai > 0 ? CATEGORY.aiPaper : physics > 0 ? CATEGORY.physicsPaper : CATEGORY.otherPaper;
  else if (isPost || host) category = ai > 0 && ai >= physics ? CATEGORY.aiPost : physics > 0 ? CATEGORY.physicsPost : CATEGORY.otherPost;
  else category = ai > physics ? CATEGORY.aiPost : physics > 0 ? CATEGORY.physicsPost : CATEGORY.other;

  const labels = [];
  if (isForm) {
    const formText = `${text}\n${target}`;
    for (const [purpose, words] of Object.entries(FORM_PURPOSES)) if (words.some((w) => has(formText, w))) labels.push(purpose);
  } else {
    const ranked = Object.entries(TOPICS)
      .map(([topic, words]) => [topic, score(title, body, words)])
      .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    labels.push(...ranked.slice(0, 4).map(([topic]) => topic));
  }

  const urgency = DEADLINE.test(text) ? 'urgent' : isForm ? 'soon' : 'whenever';
  return { category, labels: labels.slice(0, 5), urgency };
}

module.exports = { classify, CATEGORY, CATEGORIES: Object.values(CATEGORY) };
