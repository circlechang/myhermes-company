"""供應商目錄（依 Hermes 0.20.5 hermes_cli/auth.py PROVIDER_REGISTRY 整理，dev 時一次性產生；不 import Hermes 內部模組）。

auth_type: oauth_device_code / oauth_external / oauth_minimax / api_key / external_process / aws_sdk / vertex
"""
from __future__ import annotations

BUILTIN_PROVIDERS: list[dict] = [
 {
  "id": "nous",
  "name": "Nous Portal",
  "auth_type": "oauth_device_code",
  "base_url": "https://inference-api.nousresearch.com/v1",
  "key_envs": [],
  "base_url_env": ""
 },
 {
  "id": "openai-codex",
  "name": "OpenAI Codex",
  "auth_type": "oauth_external",
  "base_url": "https://chatgpt.com/backend-api/codex",
  "key_envs": [],
  "base_url_env": ""
 },
 {
  "id": "openrouter",
  "name": "OpenRouter",
  "auth_type": "api_key",
  "base_url": "https://openrouter.ai/api/v1",
  "key_envs": [
   "OPENROUTER_API_KEY"
  ],
  "base_url_env": "OPENROUTER_BASE_URL"
 },
 {
  "id": "openai-api",
  "name": "OpenAI API",
  "auth_type": "api_key",
  "base_url": "https://api.openai.com/v1",
  "key_envs": [
   "OPENAI_API_KEY"
  ],
  "base_url_env": "OPENAI_BASE_URL"
 },
 {
  "id": "xai-oauth",
  "name": "xAI Grok OAuth (SuperGrok / Premium+)",
  "auth_type": "oauth_external",
  "base_url": "https://api.x.ai/v1",
  "key_envs": [],
  "base_url_env": ""
 },
 {
  "id": "qwen-oauth",
  "name": "Qwen OAuth",
  "auth_type": "oauth_external",
  "base_url": "https://portal.qwen.ai/v1",
  "key_envs": [],
  "base_url_env": ""
 },
 {
  "id": "lmstudio",
  "name": "LM Studio",
  "auth_type": "api_key",
  "base_url": "http://127.0.0.1:1234/v1",
  "key_envs": [
   "LM_API_KEY"
  ],
  "base_url_env": "LM_BASE_URL"
 },
 {
  "id": "copilot",
  "name": "GitHub Copilot",
  "auth_type": "api_key",
  "base_url": "https://api.githubcopilot.com",
  "key_envs": [
   "COPILOT_GITHUB_TOKEN",
   "GH_TOKEN",
   "GITHUB_TOKEN"
  ],
  "base_url_env": "COPILOT_API_BASE_URL"
 },
 {
  "id": "copilot-acp",
  "name": "GitHub Copilot ACP",
  "auth_type": "external_process",
  "base_url": "acp://copilot",
  "key_envs": [],
  "base_url_env": "COPILOT_ACP_BASE_URL"
 },
 {
  "id": "gemini",
  "name": "Google AI Studio",
  "auth_type": "api_key",
  "base_url": "https://generativelanguage.googleapis.com/v1beta",
  "key_envs": [
   "GOOGLE_API_KEY",
   "GEMINI_API_KEY"
  ],
  "base_url_env": "GEMINI_BASE_URL"
 },
 {
  "id": "zai",
  "name": "Z.AI / GLM",
  "auth_type": "api_key",
  "base_url": "https://api.z.ai/api/paas/v4",
  "key_envs": [
   "GLM_API_KEY",
   "ZAI_API_KEY",
   "Z_AI_API_KEY"
  ],
  "base_url_env": "GLM_BASE_URL"
 },
 {
  "id": "kimi-coding",
  "name": "Kimi / Moonshot",
  "auth_type": "api_key",
  "base_url": "https://api.moonshot.ai/v1",
  "key_envs": [
   "KIMI_API_KEY",
   "KIMI_CODING_API_KEY"
  ],
  "base_url_env": "KIMI_BASE_URL"
 },
 {
  "id": "kimi-coding-cn",
  "name": "Kimi / Moonshot (China)",
  "auth_type": "api_key",
  "base_url": "https://api.moonshot.cn/v1",
  "key_envs": [
   "KIMI_CN_API_KEY"
  ],
  "base_url_env": ""
 },
 {
  "id": "stepfun",
  "name": "StepFun Step Plan",
  "auth_type": "api_key",
  "base_url": "https://api.stepfun.ai/step_plan/v1",
  "key_envs": [
   "STEPFUN_API_KEY"
  ],
  "base_url_env": "STEPFUN_BASE_URL"
 },
 {
  "id": "arcee",
  "name": "Arcee AI",
  "auth_type": "api_key",
  "base_url": "https://api.arcee.ai/api/v1",
  "key_envs": [
   "ARCEEAI_API_KEY"
  ],
  "base_url_env": "ARCEE_BASE_URL"
 },
 {
  "id": "gmi",
  "name": "GMI Cloud",
  "auth_type": "api_key",
  "base_url": "https://api.gmi-serving.com/v1",
  "key_envs": [
   "GMI_API_KEY"
  ],
  "base_url_env": "GMI_BASE_URL"
 },
 {
  "id": "actual",
  "name": "Actual Computer",
  "auth_type": "api_key",
  "base_url": "https://api.actual.inc/v1",
  "key_envs": [
   "ACTUAL_API_KEY"
  ],
  "base_url_env": "ACTUAL_BASE_URL"
 },
 {
  "id": "minimax",
  "name": "MiniMax",
  "auth_type": "api_key",
  "base_url": "https://api.minimax.io/anthropic",
  "key_envs": [
   "MINIMAX_API_KEY"
  ],
  "base_url_env": "MINIMAX_BASE_URL"
 },
 {
  "id": "minimax-oauth",
  "name": "MiniMax (OAuth · minimax.io)",
  "auth_type": "oauth_minimax",
  "base_url": "https://api.minimax.io/anthropic",
  "key_envs": [],
  "base_url_env": ""
 },
 {
  "id": "anthropic",
  "name": "Anthropic",
  "auth_type": "api_key",
  "base_url": "https://api.anthropic.com",
  "key_envs": [
   "ANTHROPIC_API_KEY",
   "ANTHROPIC_TOKEN",
   "CLAUDE_CODE_OAUTH_TOKEN"
  ],
  "base_url_env": "ANTHROPIC_BASE_URL"
 },
 {
  "id": "alibaba",
  "name": "Qwen Cloud",
  "auth_type": "api_key",
  "base_url": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  "key_envs": [
   "DASHSCOPE_API_KEY"
  ],
  "base_url_env": "DASHSCOPE_BASE_URL"
 },
 {
  "id": "alibaba-coding-plan",
  "name": "Alibaba Cloud (Coding Plan)",
  "auth_type": "api_key",
  "base_url": "https://coding-intl.dashscope.aliyuncs.com/v1",
  "key_envs": [
   "ALIBABA_CODING_PLAN_API_KEY",
   "DASHSCOPE_API_KEY"
  ],
  "base_url_env": "ALIBABA_CODING_PLAN_BASE_URL"
 },
 {
  "id": "minimax-cn",
  "name": "MiniMax (China)",
  "auth_type": "api_key",
  "base_url": "https://api.minimaxi.com/anthropic",
  "key_envs": [
   "MINIMAX_CN_API_KEY"
  ],
  "base_url_env": "MINIMAX_CN_BASE_URL"
 },
 {
  "id": "deepseek",
  "name": "DeepSeek",
  "auth_type": "api_key",
  "base_url": "https://api.deepseek.com/v1",
  "key_envs": [
   "DEEPSEEK_API_KEY"
  ],
  "base_url_env": "DEEPSEEK_BASE_URL"
 },
 {
  "id": "xai",
  "name": "xAI",
  "auth_type": "api_key",
  "base_url": "https://api.x.ai/v1",
  "key_envs": [
   "XAI_API_KEY"
  ],
  "base_url_env": "XAI_BASE_URL"
 },
 {
  "id": "nvidia",
  "name": "NVIDIA NIM",
  "auth_type": "api_key",
  "base_url": "https://integrate.api.nvidia.com/v1",
  "key_envs": [
   "NVIDIA_API_KEY"
  ],
  "base_url_env": "NVIDIA_BASE_URL"
 },
 {
  "id": "ai-gateway",
  "name": "Vercel AI Gateway",
  "auth_type": "api_key",
  "base_url": "https://ai-gateway.vercel.sh/v1",
  "key_envs": [
   "AI_GATEWAY_API_KEY"
  ],
  "base_url_env": "AI_GATEWAY_BASE_URL"
 },
 {
  "id": "opencode-zen",
  "name": "OpenCode Zen",
  "auth_type": "api_key",
  "base_url": "https://opencode.ai/zen/v1",
  "key_envs": [
   "OPENCODE_ZEN_API_KEY"
  ],
  "base_url_env": "OPENCODE_ZEN_BASE_URL"
 },
 {
  "id": "opencode-go",
  "name": "OpenCode Go",
  "auth_type": "api_key",
  "base_url": "https://opencode.ai/zen/go/v1",
  "key_envs": [
   "OPENCODE_GO_API_KEY"
  ],
  "base_url_env": "OPENCODE_GO_BASE_URL"
 },
 {
  "id": "opencode-free",
  "name": "OpenCode Free",
  "auth_type": "api_key",
  "base_url": "https://opencode.ai/zen/v1",
  "key_envs": [],
  "base_url_env": ""
 },
 {
  "id": "kilocode",
  "name": "Kilo Code",
  "auth_type": "api_key",
  "base_url": "https://api.kilo.ai/api/gateway",
  "key_envs": [
   "KILOCODE_API_KEY"
  ],
  "base_url_env": "KILOCODE_BASE_URL"
 },
 {
  "id": "huggingface",
  "name": "Hugging Face",
  "auth_type": "api_key",
  "base_url": "https://router.huggingface.co/v1",
  "key_envs": [
   "HF_TOKEN"
  ],
  "base_url_env": "HF_BASE_URL"
 },
 {
  "id": "xiaomi",
  "name": "Xiaomi MiMo",
  "auth_type": "api_key",
  "base_url": "https://api.xiaomimimo.com/v1",
  "key_envs": [
   "XIAOMI_API_KEY"
  ],
  "base_url_env": "XIAOMI_BASE_URL"
 },
 {
  "id": "tencent-tokenhub",
  "name": "Tencent TokenHub",
  "auth_type": "api_key",
  "base_url": "https://tokenhub.tencentmaas.com/v1",
  "key_envs": [
   "TOKENHUB_API_KEY"
  ],
  "base_url_env": "TOKENHUB_BASE_URL"
 },
 {
  "id": "ollama-cloud",
  "name": "Ollama Cloud",
  "auth_type": "api_key",
  "base_url": "https://ollama.com/v1",
  "key_envs": [
   "OLLAMA_API_KEY"
  ],
  "base_url_env": "OLLAMA_BASE_URL"
 },
 {
  "id": "bedrock",
  "name": "AWS Bedrock",
  "auth_type": "aws_sdk",
  "base_url": "https://bedrock-runtime.us-east-1.amazonaws.com",
  "key_envs": [],
  "base_url_env": "BEDROCK_BASE_URL"
 },
 {
  "id": "vertex",
  "name": "Google Vertex AI",
  "auth_type": "vertex",
  "base_url": "",
  "key_envs": [],
  "base_url_env": ""
 },
 {
  "id": "azure-foundry",
  "name": "Azure Foundry",
  "auth_type": "api_key",
  "base_url": "",
  "key_envs": [
   "AZURE_FOUNDRY_API_KEY"
  ],
  "base_url_env": "AZURE_FOUNDRY_BASE_URL"
 },
 {
  "id": "commandcode",
  "name": "CommandCode",
  "auth_type": "api_key",
  "base_url": "https://api.commandcode.ai/provider/v1",
  "key_envs": [
   "COMMANDCODE_API_KEY"
  ],
  "base_url_env": "COMMANDCODE_BASE_URL"
 },
 {
  "id": "commandcode-anthropic",
  "name": "CommandCode (Anthropic)",
  "auth_type": "api_key",
  "base_url": "https://api.commandcode.ai/provider/v1",
  "key_envs": [
   "COMMANDCODE_API_KEY"
  ],
  "base_url_env": "COMMANDCODE_ANTHROPIC_BASE_URL"
 },
 {
  "id": "deepinfra",
  "name": "DeepInfra",
  "auth_type": "api_key",
  "base_url": "https://api.deepinfra.com/v1/openai",
  "key_envs": [
   "DEEPINFRA_API_KEY"
  ],
  "base_url_env": "DEEPINFRA_BASE_URL"
 },
 {
  "id": "fireworks",
  "name": "Fireworks AI",
  "auth_type": "api_key",
  "base_url": "https://api.fireworks.ai/inference/v1",
  "key_envs": [
   "FIREWORKS_API_KEY"
  ],
  "base_url_env": ""
 },
 {
  "id": "meta-ai",
  "name": "Meta Model API",
  "auth_type": "api_key",
  "base_url": "https://api.meta.ai/v1",
  "key_envs": [
   "MODEL_API_KEY",
   "META_API_KEY",
   "META_MODEL_API_KEY"
  ],
  "base_url_env": "META_BASE_URL"
 },
 {
  "id": "novita",
  "name": "NovitaAI",
  "auth_type": "api_key",
  "base_url": "https://api.novita.ai/openai/v1",
  "key_envs": [
   "NOVITA_API_KEY"
  ],
  "base_url_env": "NOVITA_BASE_URL"
 },
 {
  "id": "upstage",
  "name": "Upstage Solar",
  "auth_type": "api_key",
  "base_url": "https://api.upstage.ai/v1",
  "key_envs": [
   "UPSTAGE_API_KEY"
  ],
  "base_url_env": "UPSTAGE_BASE_URL"
 }
]

# `hermes auth add <id> --type oauth` 可走的供應商（device flow / external browser）
OAUTH_PROVIDERS = {"anthropic", "nous", "openai-codex", "xai-oauth", "qwen-oauth", "minimax-oauth", "copilot"}

# 分組（前端顯示用，可被 prefs 覆蓋）
DEFAULT_GROUPS = {
    "訂閱／OAuth": ["openai-codex", "anthropic", "nous", "xai-oauth", "qwen-oauth", "minimax-oauth", "copilot"],
    "聚合器": ["openrouter", "ai-gateway", "kilocode", "opencode-zen", "opencode-go", "opencode-free", "huggingface", "commandcode", "commandcode-anthropic"],
    "官方 API": ["openai-api", "gemini", "deepseek", "xai", "zai", "kimi-coding", "kimi-coding-cn", "minimax", "minimax-cn", "alibaba", "alibaba-coding-plan", "stepfun", "xiaomi", "tencent-tokenhub", "meta-ai", "upstage", "arcee"],
    "雲端／推論平台": ["nvidia", "fireworks", "novita", "deepinfra", "gmi", "actual", "ollama-cloud", "bedrock", "vertex", "azure-foundry"],
    "本機": ["lmstudio", "copilot-acp"],
}

# STT / TTS 供應商目錄（config.yaml tts.provider / stt.provider 的值 ＋ 需要的 env）
TTS_PROVIDERS = [
    {"id": "edge", "name": "Edge TTS（免費）", "key_envs": [], "config_keys": ["voice"]},
    {"id": "openai", "name": "OpenAI TTS", "key_envs": ["OPENAI_API_KEY"], "config_keys": ["model", "voice"]},
    {"id": "elevenlabs", "name": "ElevenLabs", "key_envs": ["ELEVENLABS_API_KEY"], "config_keys": ["voice_id", "model_id"]},
    {"id": "gemini", "name": "Gemini TTS", "key_envs": ["GOOGLE_API_KEY", "GEMINI_API_KEY"], "config_keys": ["model", "voice"]},
    {"id": "xai", "name": "xAI TTS", "key_envs": ["XAI_API_KEY"], "config_keys": ["voice_id", "language"]},
    {"id": "mistral", "name": "Mistral Voxtral TTS", "key_envs": ["MISTRAL_API_KEY"], "config_keys": ["model", "voice_id"]},
    {"id": "neutts", "name": "NeuTTS（本機）", "key_envs": [], "config_keys": ["model", "device", "ref_audio", "ref_text"]},
    {"id": "piper", "name": "Piper（本機）", "key_envs": [], "config_keys": ["voice"]},
]
STT_PROVIDERS = [
    {"id": "local", "name": "本機 Whisper", "key_envs": [], "config_keys": ["model", "language"]},
    {"id": "openai", "name": "OpenAI Whisper API", "key_envs": ["OPENAI_API_KEY"], "config_keys": ["model"]},
    {"id": "mistral", "name": "Mistral Voxtral", "key_envs": ["MISTRAL_API_KEY"], "config_keys": ["model"]},
    {"id": "elevenlabs", "name": "ElevenLabs Scribe", "key_envs": ["ELEVENLABS_API_KEY"], "config_keys": ["model_id", "language_code"]},
    {"id": "groq", "name": "Groq Whisper", "key_envs": ["GROQ_API_KEY"], "config_keys": ["model"]},
]

