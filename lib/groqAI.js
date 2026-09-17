const axios = require("axios");
const CONFIG = require("../config.js");

// ── In-memory chat history ──────────────────────────
const chatHistory = new Map();
const CHAT_HISTORY_TTL = 30 * 60 * 1000; // 30 min
setInterval(() => {
    const now = Date.now();
    for (const [jid, entry] of chatHistory) {
        if (entry._ts && now - entry._ts > CHAT_HISTORY_TTL) chatHistory.delete(jid);
    }
}, 5 * 60 * 1000).unref();

function getHistory(jid) {
  if (!chatHistory.has(jid)) chatHistory.set(jid, { messages: [], _ts: Date.now() });
  return chatHistory.get(jid).messages;
}

function addToHistory(jid, role, content) {
  const history = getHistory(jid);
  chatHistory.get(jid)._ts = Date.now();
  history.push({
    role,
    content: Array.from(String(content).replace(/\s+/g, " ")).slice(0, 1000).join("")
  });
  if (history.length > 20) history.splice(0, history.length - 20);
}

function clearHistory(jid) {
  chatHistory.delete(jid);
}

function clearAllHistory() {
  chatHistory.clear();
}

async function askGroq(jid, userMessage, senderName, opts = {}) {
  const name = senderName || "User";
  const trimmed = userMessage.trim();

  if (/^\/(clear|reset|new)$/i.test(trimmed)) {
    clearHistory(jid);
    return "aight bet";
  }

  const apiKey = (process.env.GROQ_API_KEY || CONFIG.GROQ_API_KEY || "").trim();

  if (!apiKey || apiKey.length < 10) {
    console.error("[GroqAI] Missing API key");
    return "my bad, something went wrong. try again later.";
  }

  const botName = (opts.botName || CONFIG.BOT_NAME || "Alex").trim() || "Alex";
  const customInstructions = (opts.instructions || "").trim();

  const systemPrompt =
    `You are ${botName}, a WhatsApp assistant serving customers in Ghana.

Rules:
1. Use standard English by default.
2. Detect whether the user is speaking Ghanaian Pidgin.
3. Only reply in Ghanaian Pidgin if the user has already used Pidgin.
4. Match the user's language style.
5. Keep responses concise and friendly.
6. Do not mix English and Pidgin unnecessarily.
7. If unsure whether a message is Pidgin, use English.

You're talking to ${name}.${customInstructions ? `\n\nAdditional instructions from the account owner:\n${customInstructions}` : ""}`;
  
  addToHistory(jid, "user", userMessage);
  const msgIndex = getHistory(jid).length - 1;

  const messages = [
    { role: "system", content: systemPrompt },
    ...getHistory(jid)
  ];

  try {
    const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
      model: "openai/gpt-oss-120b",
      messages,
      max_tokens: 150,
      temperature: 0.9
    }, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      timeout: 15000
    });

    const reply = res.data?.choices?.[0]?.message?.content?.trim();
    if (!reply) throw new Error("Empty AI response");

    addToHistory(jid, "assistant", reply);
    return reply;
  } catch (err) {
    console.error("[GroqAI]", err.message);
    const history = getHistory(jid);
    if (history[msgIndex]?.role === "user") history.splice(msgIndex, 1);
    return "my bad, something went wrong. try again later.";
  }
}

async function transcribeVoice(buffer, mimetype) {
  const apiKey = (process.env.GROQ_API_KEY || CONFIG.GROQ_API_KEY || '').trim();
  if (!apiKey || apiKey.length < 10) throw new Error('Missing API key');
  if (!buffer || !buffer.length) throw new Error('Empty audio');
  if (buffer.length > 20 * 1024 * 1024) throw new Error('Voice note too long');

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype || 'audio/ogg' }), 'voice.ogg');
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'verbose_json');

  const res = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 45000,
    maxBodyLength: Infinity
  });

  const data = res.data || {};
  // verbose_json gives per-segment confidence. Filter hallucinations when
  // segments exist; fall back to plain text for flat responses.
  if (Array.isArray(data.segments) && data.segments.length) {
    const kept = data.segments.filter(s =>
      (s.no_speech_prob ?? 0) < 0.6 && (s.avg_logprob ?? 0) > -1.0);
    const text = kept.map(s => s.text || '').join(' ').trim();
    return text;
  }
  return (data.text || '').trim();
}


module.exports = { askGroq, clearHistory, clearAllHistory, transcribeVoice };
