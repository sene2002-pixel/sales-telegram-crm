import os
from dotenv import load_dotenv

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN", "")

# OpenAI-совместимый эндпоинт. Работает с:
#   OpenAI          -> https://api.openai.com/v1
#   ProxyAPI (РФ)   -> https://api.proxyapi.ru/openai/v1
#   VseGPT (РФ)     -> https://api.vsegpt.ru/v1
#   DeepSeek        -> https://api.deepseek.com/v1  (без STT)
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "https://api.openai.com/v1")
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")

# STT. По умолчанию тот же провайдер, что и LLM.
STT_BASE_URL = os.getenv("STT_BASE_URL", LLM_BASE_URL)
STT_API_KEY = os.getenv("STT_API_KEY", LLM_API_KEY)
STT_MODEL = os.getenv("STT_MODEL", "whisper-1")

DB_PATH = os.getenv("DB_PATH", "tracker.db")
API_PORT = int(os.getenv("API_PORT", "8080"))
# Только для локальной отладки без Telegram: подставляет этот id, если нет initData.
DEV_USER_ID = int(os.getenv("DEV_USER_ID", "0")) or None
# Белый список Telegram ID. ПУСТОЙ СПИСОК = бот открыт всем, кто его найдёт.
ALLOWED_IDS = [int(x) for x in os.getenv("ALLOWED_IDS", "").split(",") if x.strip()]

# Лимиты защиты от слива бюджета и забивания диска
MAX_VOICE_SEC = int(os.getenv("MAX_VOICE_SEC", "300"))      # длина голосового
MAX_FILE_BYTES = int(os.getenv("MAX_FILE_BYTES", "20971520"))
MAX_TEXT_CHARS = int(os.getenv("MAX_TEXT_CHARS", "4000"))
RATE_PER_MIN = int(os.getenv("RATE_PER_MIN", "10"))         # запросов к ИИ в минуту
RATE_PER_DAY = int(os.getenv("RATE_PER_DAY", "150"))        # запросов к ИИ в сутки
