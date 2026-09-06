'use strict';
/**
 * api-registry.js
 *
 * The Free API Hub data model (PART B/F): a native registry of legitimate
 * APIs/services that can extend the workstation, with explicit capability
 * tags, HONEST free-status classification, and verification metadata.
 *
 * The public-apis/public-apis repository is a DISCOVERY CATALOGUE REFERENCE
 * (§ PART B): we ship a small normalized sample plus a search/filter engine —
 * never a copy of thousands of entries, and no discovered API is ever
 * auto-activated. Discovered entries are metadata for the user to review;
 * connecting one always requires explicit user action.
 *
 * Free-status vocabulary (honest by construction):
 *   truly-free        no paid subscription required for the listed capability
 *   free-tier         a legitimate free tier exists, with usage limits
 *   trial-credits     access via trial/promotional credits — NOT permanently free
 *   needs-verification  pricing/quota could not be verified — never guessed
 *
 * Credentials NEVER live here — they belong to the masked provider
 * configuration subsystem.
 */

const REGISTRY = [
  {
    id: 'groq',
    name: 'Groq',
    purpose: 'Fast LLM inference (OpenAI-compatible)',
    division: 'AI/LLM',
    capabilities: ['llm', 'chat', 'reasoning', 'coding', 'tool-calling', 'structured-output'],
    freeStatus: 'free-tier',
    authType: 'api-key',
    keyRequired: true,
    local: false,
    officialUrl: 'https://console.groq.com',
    docsUrl: 'https://console.groq.com/docs',
    keyUrl: 'https://console.groq.com/keys',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'openai/gpt-oss-120b',
    notes: 'Free tier with rate limits (per-minute and daily token caps are enforced by the provider and vary by model).',
    lastVerified: '2026-09-06',
    source: 'provider docs (console.groq.com)',
    sourceType: 'official',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    purpose: 'Google AI Studio models (OpenAI-compatible layer)',
    division: 'AI/LLM',
    capabilities: ['llm', 'chat', 'reasoning', 'coding', 'vision', 'structured-output'],
    freeStatus: 'free-tier',
    authType: 'api-key',
    keyRequired: true,
    local: false,
    officialUrl: 'https://aistudio.google.com',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    keyUrl: 'https://aistudio.google.com/apikey',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-3.6-flash',
    notes: 'Free tier with per-day/per-minute quotas enforced by Google. Quotas vary by model and can change.',
    lastVerified: '2026-09-06',
    source: 'provider docs (ai.google.dev)',
    sourceType: 'official',
  },
  {
    id: 'github-models',
    name: 'GitHub Models',
    purpose: 'Hosted frontier models via the GitHub Models catalog (OpenAI-compatible endpoint)',
    division: 'AI/LLM',
    capabilities: ['llm', 'chat', 'reasoning', 'coding', 'structured-output'],
    freeStatus: 'free-tier',
    authType: 'github-token',
    keyRequired: true,
    local: false,
    officialUrl: 'https://github.com/marketplace/models',
    docsUrl: 'https://docs.github.com/en/github-models',
    keyUrl: 'https://github.com/settings/tokens',
    baseUrl: 'https://models.github.ai/inference',
    defaultModel: 'openai/gpt-4o-mini',
    notes: 'Free/limited use tied to a GitHub account with rate limits by entitlement; requires a GitHub PAT with models:read.',
    lastVerified: '2026-09-06',
    source: 'provider docs (docs.github.com)',
    sourceType: 'official',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    purpose: 'Unified gateway to many models, including free-tier models',
    division: 'AI/LLM',
    capabilities: ['llm', 'chat', 'reasoning', 'coding', 'vision'],
    freeStatus: 'free-tier',
    authType: 'api-key',
    keyRequired: true,
    local: false,
    officialUrl: 'https://openrouter.ai',
    docsUrl: 'https://openrouter.ai/docs',
    keyUrl: 'https://openrouter.ai/keys',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    notes: 'Models with a ":free" suffix have a free tier with daily limits; paid models require credits.',
    lastVerified: '2026-09-06',
    source: 'provider docs (openrouter.ai/docs)',
    sourceType: 'official',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    purpose: 'Local model runtime — your code never leaves the machine',
    division: 'AI/LLM (local)',
    capabilities: ['llm', 'chat', 'local-inference', 'coding', 'embeddings'],
    freeStatus: 'truly-free',
    authType: 'none',
    keyRequired: false,
    local: true,
    officialUrl: 'https://ollama.com',
    docsUrl: 'https://github.com/ollama/ollama/blob/main/README.md',
    keyUrl: null,
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: null,
    notes: 'Runs locally; models are downloaded to your machine. Availability depends on the local service running (ollama serve).',
    lastVerified: '2026-09-06',
    source: 'provider docs (ollama.com)',
    sourceType: 'official',
  },
  {
    id: 'github-rest',
    name: 'GitHub REST API',
    purpose: 'Repositories, issues, pull requests, actions — code-hosting automation',
    division: 'Developer tools',
    capabilities: ['repository', 'github', 'issues', 'search'],
    freeStatus: 'free-tier',
    authType: 'github-token',
    keyRequired: true,
    local: false,
    officialUrl: 'https://docs.github.com/en/rest',
    docsUrl: 'https://docs.github.com/en/rest',
    keyUrl: 'https://github.com/settings/tokens',
    baseUrl: 'https://api.github.com',
    defaultModel: null,
    notes: 'Free with authenticated rate limits (5000 req/h per token).',
    lastVerified: '2026-09-06',
    source: 'provider docs (docs.github.com)',
    sourceType: 'official',
  },
  {
    id: 'tavily',
    name: 'Tavily',
    purpose: 'Web search API tuned for AI agents',
    division: 'Search',
    capabilities: ['search', 'web-search'],
    freeStatus: 'free-tier',
    authType: 'api-key',
    keyRequired: true,
    local: false,
    officialUrl: 'https://tavily.com',
    docsUrl: 'https://docs.tavily.com',
    keyUrl: 'https://app.tavily.com/home',
    baseUrl: 'https://api.tavily.com',
    defaultModel: null,
    notes: 'Free monthly tier exists; limits are set by the provider and can change.',
    lastVerified: '2026-09-06',
    source: 'provider docs (docs.tavily.com)',
    sourceType: 'official',
  },
  {
    id: 'brave-search',
    name: 'Brave Search API',
    purpose: 'Independent web search API',
    division: 'Search',
    capabilities: ['search', 'web-search'],
    freeStatus: 'free-tier',
    authType: 'api-key',
    keyRequired: true,
    local: false,
    officialUrl: 'https://brave.com/search/api',
    docsUrl: 'https://api-dashboard.search.brave.com/app/documentation',
    keyUrl: 'https://api-dashboard.search.brave.com/app/keys',
    baseUrl: 'https://api.search.brave.com/res/v1',
    defaultModel: null,
    notes: 'Free tier exists with monthly query limits set by the provider.',
    lastVerified: '2026-09-06',
    source: 'provider docs (brave.com/search/api)',
    sourceType: 'official',
  },
  {
    id: 'nomic',
    name: 'Nomic Atlas',
    purpose: 'Embeddings and text models for semantic workflows',
    division: 'AI/Embeddings',
    capabilities: ['embeddings', 'llm'],
    freeStatus: 'trial-credits',
    authType: 'api-key',
    keyRequired: true,
    local: false,
    officialUrl: 'https://atlas.nomic.ai',
    docsUrl: 'https://docs.nomic.ai',
    keyUrl: 'https://atlas.nomic.ai/profile',
    baseUrl: 'https://api-atlas.nomic.ai/v1',
    defaultModel: 'nomic-embed-text-v1.5',
    notes: 'Access starts with trial credits — NOT permanently free. Verify current pricing with the provider.',
    lastVerified: '2026-09-06',
    source: 'provider docs (docs.nomic.ai)',
    sourceType: 'official',
  },
];

// ---------------------------------------------------------------------------
// Public-apis catalogue reference: a small NORMALIZED sample of the kinds of
// entries the discovery engine handles (health, dev tools, finance, search).
// Full catalogue: https://github.com/public-apis/public-apis — never imported
// wholesale. Discovered entries are metadata-only until a user connects them.
const PUBLIC_APIS_SAMPLE = [
  { name: 'GitHub API', description: 'Repository, issue, and PR data for developer workflows', category: 'Development', capabilities: ['repository', 'github', 'search'], authType: 'apiKey', https: true, cors: 'unknown', officialUrl: 'https://docs.github.com/en/rest', pricingType: 'free-tier', verificationStatus: 'verified', source: 'public-apis catalogue', lastVerified: '2026-09-06' },
  { name: 'Health.gov', description: 'Health information and resources', category: 'Health', capabilities: ['data'], authType: 'none', https: true, cors: 'unknown', officialUrl: 'https://health.gov/our-work/national-health-initiatives/health-literacy/consumer-health-content/free-web-services-apis', pricingType: 'truly-free', verificationStatus: 'needs-verification', source: 'public-apis catalogue', lastVerified: null },
  { name: 'Frankfurter', description: 'Exchange rate references (European Central Bank data)', category: 'Finance', capabilities: ['data', 'finance'], authType: 'none', https: true, cors: 'yes', officialUrl: 'https://www.frankfurter.app', pricingType: 'truly-free', verificationStatus: 'needs-verification', source: 'public-apis catalogue', lastVerified: null },
  { name: 'HackerNews API', description: 'Community-curated tech news (Firebase-backed)', category: 'News', capabilities: ['data', 'search'], authType: 'none', https: true, cors: 'unknown', officialUrl: 'https://github.com/HackerNews/API', pricingType: 'truly-free', verificationStatus: 'needs-verification', source: 'public-apis catalogue', lastVerified: null },
  { name: 'Open Library', description: 'Open book catalog and metadata', category: 'Data', capabilities: ['data', 'search'], authType: 'none', https: true, cors: 'unknown', officialUrl: 'https://openlibrary.org/developers/api', pricingType: 'truly-free', verificationStatus: 'needs-verification', source: 'public-apis catalogue', lastVerified: null },
  { name: 'Shields.io', description: 'Badge generation for project READMEs', category: 'Development', capabilities: ['utilities'], authType: 'none', https: true, cors: 'yes', officialUrl: 'https://shields.io', pricingType: 'truly-free', verificationStatus: 'needs-verification', source: 'public-apis catalogue', lastVerified: null },
];

/** Registry entries for the Free API Hub UI. */
function listRegistryApis() {
  return REGISTRY.map(({ baseUrl, ...meta }) => ({ ...meta, compatible: isCompatibleWithWorkstation(meta) }));
}

function isCompatibleWithWorkstation(meta) {
  // LLM providers must be OpenAI-compatible or local; others are metadata-only
  // until a user explicitly builds an adapter for them.
  return meta.capabilities.includes('llm') || meta.capabilities.includes('local-inference') || meta.id === 'github-rest';
}

/**
 * Public-apis discovery: normalized search/filter over the sample catalogue.
 * Filters: q (name/description), category, capability, auth, free/pricing,
 * httpsOnly. Unknown/unverified entries are returned with their honest
 * verificationStatus — nothing is auto-activated.
 */
function searchPublicApis({ q, category, capability, authType, pricingType, httpsOnly } = {}) {
  let out = PUBLIC_APIS_SAMPLE.slice();
  if (q) {
    const needle = String(q).toLowerCase();
    out = out.filter((a) => `${a.name} ${a.description}`.toLowerCase().includes(needle));
  }
  if (category) out = out.filter((a) => a.category.toLowerCase() === String(category).toLowerCase());
  if (capability) out = out.filter((a) => a.capabilities.includes(String(capability).toLowerCase()));
  if (authType) out = out.filter((a) => a.authType.toLowerCase() === String(authType).toLowerCase());
  if (pricingType) out = out.filter((a) => a.pricingType === pricingType);
  if (httpsOnly) out = out.filter((a) => a.https);
  return out;
}

/**
 * Capability-based recommendation: given a required capability, rank
 * registry entries that could serve it (free-first, local-aware), with an
 * explicit `action` for the user. Nothing is auto-activated.
 */
function recommendForCapability(capability) {
  const rank = { 'truly-free': 0, 'free-tier': 1, 'trial-credits': 2, 'needs-verification': 3 };
  return REGISTRY.filter((r) => r.capabilities.includes(capability))
    .sort((a, b) => (rank[a.freeStatus] ?? 9) - (rank[b.freeStatus] ?? 9))
    .map((r) => ({
      id: r.id,
      name: r.name,
      freeStatus: r.freeStatus,
      local: !!r.local,
      action: r.local
        ? 'Start Ollama locally, then use ♻ Detect Local in the Providers panel.'
        : 'Get a legitimate key from the official site, then Connect + Test in the Free API Hub.',
      officialUrl: r.officialUrl,
    }));
}

module.exports = { listRegistryApis, searchPublicApis, recommendForCapability, REGISTRY, PUBLIC_APIS_SAMPLE };
