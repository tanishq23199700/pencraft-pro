/**
 * PenCraft Pro — Main Dashboard Application Logic
 * Firebase Auth + Firestore key storage + Gemini API rewriting
 */

import { initializeApp }         from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { FIREBASE_CONFIG } from "./firebase-config.js";

// ─── Init ─────────────────────────────────────────────────────────────────────
const app  = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db   = getFirestore(app);

let currentUser   = null;
let userSettings  = {};
let currentMode   = 'both';
let rewriteAbort  = null;
let seoAbort      = null;
let seoRawText    = '';

// ─── Auth Guard ───────────────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = 'auth.html';
    return;
  }
  
  // Check if they need the onboarding tour
  if (!localStorage.getItem('pencraftTourComplete')) {
    document.getElementById('welcome-modal').classList.remove('hidden');
  }

  currentUser = user;
  
  // Populate user info in sidebar
  const initials = (user.displayName || user.email || 'U')[0].toUpperCase();
  document.getElementById('sb-avatar').textContent = initials;
  document.getElementById('sb-name').textContent   = user.displayName || 'User';
  document.getElementById('sb-email').textContent  = user.email;

  await loadSettings();

  // Enforce minimum 7 second splash screen delay
  setTimeout(() => {
    document.getElementById('auth-guard').style.display = 'none';
    document.getElementById('dash').classList.remove('hidden');
  }, 7000);
});

window.doSignOut = async () => {
  await signOut(auth);
  window.location.href = 'auth.html';
};

// ─── Settings Load / Save ─────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, 'users', currentUser.uid));
    if (snap.exists()) {
      userSettings = snap.data();
      const keys = userSettings.apiKeys || {};
      if (keys.gemini) document.getElementById('key-gemini').value = keys.gemini;
      if (keys.openai) document.getElementById('key-openai').value = keys.openai;
      if (keys.claude) document.getElementById('key-claude').value = keys.claude;

      const provider = userSettings.defaultProvider || 'gemini';
      const tone     = userSettings.defaultTone     || 'Professional';
      setSelectValue('pref-provider', provider);
      setSelectValue('pref-tone', tone);
      setSelectValue('tone-select', tone);
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

window.saveSettings = async () => {
  const keys = {
    gemini: document.getElementById('key-gemini').value.trim(),
    openai: document.getElementById('key-openai').value.trim(),
    claude: document.getElementById('key-claude').value.trim(),
  };
  const provider = document.getElementById('pref-provider').value;
  const tone = document.getElementById('pref-tone').value;

  try {
    await setDoc(doc(db, 'users', currentUser.uid), {
      ...userSettings,
      apiKeys: keys,
      defaultProvider: provider,
      defaultTone: tone,
    }, { merge: true });

    userSettings = { ...userSettings, apiKeys: keys, defaultProvider: provider, defaultTone: tone };
    setSelectValue('tone-select', tone);
    showSettingsMsg('✅ Settings saved!', false);
  } catch (e) {
    showSettingsMsg('❌ Failed to save: ' + e.message, true);
  }
};

function showSettingsMsg(msg, isError) {
  const el = document.getElementById('settings-msg');
  el.textContent = msg;
  el.className = 'auth-msg ' + (isError ? 'auth-msg--error' : 'auth-msg--success');
  setTimeout(() => el.className = 'auth-msg hidden', 3000);
}

// ─── Panel Navigation ─────────────────────────────────────────────────────────
window.switchPanel = (name) => {
  document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.sb-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`panel-${name}`).classList.remove('hidden');
  document.querySelector(`[data-panel="${name}"]`).classList.add('active');
};

// ─── Rewriter ─────────────────────────────────────────────────────────────────
window.setMode = (mode) => {
  currentMode = mode;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`mode-${mode}`).classList.add('active');
};

window.startRewrite = async () => {
  const text = document.getElementById('input-text').value.trim();
  if (!text) { setRwStatus('⚠ Please enter some text first.'); return; }

  const tone = document.getElementById('tone-select').value;
  document.getElementById('output-text').value = '';
  document.getElementById('btn-rewrite').disabled = true;
  document.getElementById('btn-stop').disabled = false;
  document.getElementById('rw-progress-wrap').style.display = 'flex';
  document.getElementById('rw-done-msg').textContent = '';
  setRwStatus('⚙ Rewriting...');

  rewriteAbort = new AbortController();
  const systemPrompt = buildRewritePrompt(currentMode, tone, []);

  try {
    let fullOutput = await aiGenerateWithFallback(
      systemPrompt,
      `Text to rewrite:\n\n${text}`,
      (chunk) => {
        const ta = document.getElementById('output-text');
        ta.value += chunk;
        ta.scrollTop = ta.scrollHeight;
      },
      rewriteAbort.signal,
      currentMode === 'humanize' || currentMode === 'both' ? 0.95 : 0.7
    );

    // Second humanization pass
    if ((currentMode === 'humanize' || currentMode === 'both') && fullOutput) {
      setRwStatus('⚙ Second humanization pass...');
      const secondPrompt = buildSecondPassPrompt();
      const secondOutput = await aiGenerateWithFallback(
        secondPrompt,
        `Polish this text to sound more human:\n\n${document.getElementById('output-text').value}`,
        (chunk) => {
          const ta = document.getElementById('output-text');
          if (ta.value === '' || ta.dataset.secondPass !== '1') {
            ta.dataset.secondPass = '1';
            ta.value = '';
          }
          ta.value += chunk;
          ta.scrollTop = ta.scrollHeight;
        },
        rewriteAbort.signal,
        0.97
      );
    }

    setRwStatus('✅ Done!');
    updateOutputScores();
  } catch (e) {
    if (e.name !== 'AbortError') setRwStatus('❌ ' + (e.message || 'Error rewriting.'));
  } finally {
    document.getElementById('btn-rewrite').disabled = false;
    document.getElementById('btn-stop').disabled = true;
    document.getElementById('rw-progress-wrap').style.display = 'none';
    document.getElementById('output-text').dataset.secondPass = '';
  }
};

window.stopRewrite = () => {
  rewriteAbort?.abort();
  setRwStatus('⏹ Stopped.');
  document.getElementById('btn-rewrite').disabled = false;
  document.getElementById('btn-stop').disabled = true;
  document.getElementById('rw-progress-wrap').style.display = 'none';
};

window.copyOutput = () => {
  const text = document.getElementById('output-text').value;
  if (text) { navigator.clipboard.writeText(text); setRwStatus('📋 Copied!'); }
};

window.clearAll = () => {
  document.getElementById('input-text').value = '';
  document.getElementById('output-text').value = '';
  resetScores();
  setRwStatus('');
};

function setRwStatus(msg) {
  document.getElementById('rw-done-msg').textContent = msg;
}

// Live word count
document.getElementById('input-text').addEventListener('input', () => {
  const words = countWords(document.getElementById('input-text').value);
  document.getElementById('in-words').textContent = words + ' words';
  updateInputScores();
});
document.getElementById('output-text').addEventListener('input', () => {
  const words = countWords(document.getElementById('output-text').value);
  document.getElementById('out-words').textContent = words + ' words';
});

// ─── WordPress Hub ────────────────────────────────────────────────────────────
let wpRawText = '';
window.setWPTool = (tool) => {
  document.querySelectorAll('.wp-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.wp-tool-panel').forEach(p => p.classList.add('hidden'));
  event.target.classList.add('active');
  document.getElementById(`wp-tool-${tool}`).classList.remove('hidden');
};

window.runWPTool = async (tool) => {
  document.getElementById('wp-output').innerHTML = '<div class="seo-streaming">Generating...</div>';
  const streamEl = document.querySelector('.seo-streaming');
  wpRawText = '';
  
  let systemPrompt = '';
  let userPrompt = '';
  
  if (tool === 'elementor') {
    const name = document.getElementById('wp-el-name').value;
    const type = document.getElementById('wp-el-type').value;
    const raw = document.getElementById('wp-el-raw').value;
    systemPrompt = "You are an elite real estate copywriter. Write highly persuasive, formatted copy specifically designed to be pasted into WordPress/Elementor text widgets. Keep it punchy, use short paragraphs, and do NOT use markdown asterisks (**) or raw HTML. Use clean paragraph breaks.";
    userPrompt = `Project: ${name}\nSection needed: ${type}\nRaw details:\n${raw}`;
  } else if (tool === 'yoast') {
    const kw = document.getElementById('wp-yo-kw').value;
    const raw = document.getElementById('wp-yo-raw').value;
    systemPrompt = "You are an SEO expert generating exact metadata for Yoast/RankMath. Do NOT use markdown bolding. Output exactly 3 lines:\nFocus Keyword: [kw]\nSEO Title: [under 60 chars]\nMeta Description: [under 160 chars with a CTA]";
    userPrompt = `Target keyword: ${kw}\nContent summary:\n${raw}`;
  } else if (tool === 'neighborhood') {
    const loc = document.getElementById('wp-nb-loc').value;
    const focus = document.getElementById('wp-nb-focus').value;
    systemPrompt = "You are a local real estate expert. Write a comprehensive neighborhood guide blog post. Format it cleanly without markdown asterisks so it can be pasted into Gutenberg. Use numbered lists and clear headings.";
    userPrompt = `Location: ${loc}\nFocus: ${focus}\nWrite a detailed neighborhood guide based on real local data.`;
  }
  
  try {
    const abort = new AbortController();
    await aiGenerateWithFallback(
      systemPrompt, userPrompt,
      (chunk) => {
        wpRawText += chunk;
        streamEl.textContent = wpRawText;
        streamEl.scrollTop = streamEl.scrollHeight;
      },
      abort.signal, 0.7, tool === 'neighborhood'
    );
    // Use dedicated Yoast renderer for structured output, markdown for everything else
    if (tool === 'yoast') {
      document.getElementById('wp-output').innerHTML = renderYoast(wpRawText);
    } else {
      document.getElementById('wp-output').innerHTML = renderMarkdown(wpRawText);
    }
  } catch (e) {
    document.getElementById('wp-output').innerHTML = `<p style="color:#EF4444">❌ ${e.message}</p>`;
  }
};

window.copyWP = () => {
  if (wpRawText) {
    // Strip markdown bold/italics for clean WP pasting
    const cleanText = wpRawText.replace(/\*\*/g, '').replace(/\*/g, '');
    navigator.clipboard.writeText(cleanText);
    alert('Copied clean text for WordPress!');
  }
};

// ─── SEO Intel ────────────────────────────────────────────────────────────────
window.startSEO = async () => {
  const query = document.getElementById('seo-query').value.trim();
  if (!query) { return; }

  const provider   = userSettings.defaultProvider || 'gemini';
  const keyForProv = (userSettings.apiKeys || {})[provider] || '';
  if (!keyForProv) {
    document.getElementById('seo-output').innerHTML =
      '<p style="color:#EF4444">❌ No API key found. Add one in Settings.</p>';
    return;
  }

  const searchType = document.querySelector('input[name="seo-type"]:checked').value;

  seoRawText = '';
  document.getElementById('btn-seo').disabled = true;
  document.getElementById('btn-seo-stop').disabled = false;
  document.getElementById('seo-progress-row').classList.remove('hidden');
  document.getElementById('seo-output').innerHTML = '<div class="seo-streaming"></div>';
  const streamEl = document.querySelector('.seo-streaming');

  seoAbort = new AbortController();

  setSEOStatus('🔍 Asking AI to analyze competitors...');

  const systemPrompt = buildSEOSystemPrompt();
  const userPrompt   = buildSEOUserPrompt(query, searchType);

  try {
    await aiGenerateWithFallback(
      systemPrompt,
      userPrompt,
      (chunk) => {
        seoRawText += chunk;
        streamEl.textContent = seoRawText;
        streamEl.scrollTop = streamEl.scrollHeight;
      },
      seoAbort.signal,
      0.7,
      true // use Google Search grounding
    );

    // Render as HTML
    document.getElementById('seo-output').innerHTML = renderMarkdown(seoRawText);
    setSEOStatus('✅ Analysis complete!');
  } catch(e) {
    if (e.name !== 'AbortError') {
      document.getElementById('seo-output').innerHTML =
        `<p style="color:#EF4444">❌ ${e.message}</p>`;
    }
  } finally {
    document.getElementById('btn-seo').disabled = false;
    document.getElementById('btn-seo-stop').disabled = true;
    document.getElementById('seo-progress-row').classList.add('hidden');
  }
};

window.stopSEO  = () => { seoAbort?.abort(); setSEOStatus('⏹ Stopped.'); document.getElementById('btn-seo').disabled = false; document.getElementById('btn-seo-stop').disabled = true; };
window.copySEO  = () => { if (seoRawText) { navigator.clipboard.writeText(seoRawText); setSEOStatus('📋 Copied!'); }};
window.clearSEO = () => { seoRawText = ''; document.getElementById('seo-output').innerHTML = '<div class="seo-placeholder"><div class="seo-placeholder-icon">🕵️</div><p>Enter a keyword or domain above.</p></div>'; setSEOStatus(''); document.getElementById('seo-query').value = ''; };

function setSEOStatus(msg) {
  document.getElementById('seo-status').textContent = msg;
}

// ─── AI Fallback Engine ───────────────────────────────────────────────────────
async function aiGenerateWithFallback(systemPrompt, userPrompt, onChunk, signal, temperature = 0.7, useGrounding = false) {
  const keys = userSettings.apiKeys || {};
  const primary = userSettings.defaultProvider || 'gemini';
  let errors = [];

  // Define the providers and their fetch functions
  const providers = {
    gemini: { name: 'Gemini', key: keys.gemini, fn: callGeminiStream },
    openai: { name: 'OpenAI', key: keys.openai, fn: callOpenAIStream },
    claude: { name: 'Claude', key: keys.claude, fn: callClaudeStream }
  };

  // Build the cascade order: primary first, then the others
  const cascadeOrder = [primary];
  Object.keys(providers).forEach(k => { if (k !== primary) cascadeOrder.push(k); });

  for (const id of cascadeOrder) {
    const prov = providers[id];
    if (!prov.key) continue; // Skip if no key entered for this provider

    try {
      const badge = document.getElementById('provider-badge');
      if (badge) badge.textContent = `● Using ${prov.name}`;
      return await prov.fn(prov.key, systemPrompt, userPrompt, onChunk, signal, temperature, useGrounding);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      console.warn(`${prov.name} Failed:`, e.message);
      errors.push(`${prov.name}: ${e.message}`);
    }
  }

  // If we reach here, all configured keys failed
  if (errors.length === 0) {
    throw new Error('❌ No API keys found! Please add an API key in Settings.');
  } else {
    throw new Error(`❌ All AI providers failed.\n` + errors.join('\n'));
  }
}

// ─── Key Verification ───
window.verifyKey = async (provider) => {
  const keyInput = document.getElementById(`key-${provider}`).value.trim();
  if (!keyInput) { alert(`Please enter an API key for ${provider} first.`); return; }

  const btn = event.currentTarget;
  const originalText = btn.textContent;
  btn.textContent = '⏳ Testing...';
  btn.disabled = true;

  try {
    if (provider === 'gemini') {
      // gemini-2.5-flash first — uses different quota bucket than 1.5/2.0 free-tier
      // (Python SDK confirms 2.5-flash works when 1.5/2.0 show limit: 0)
      const modelsToTry = [
        'gemini-2.5-flash-preview-05-20',
        'gemini-2.5-flash',
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite',
        'gemini-1.5-flash',
      ];
      let verified = false;
      let lastErr = '';
      let quotaHit = false; // track if quota was EVER the issue

      for (const model of modelsToTry) {
        btn.textContent = `⏳ Trying ${model}...`;
        try {
          const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keyInput },
              body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with one word: OK' }] }] })
            }
          );
          const data = await resp.json();
          const errMsg = (data.error?.message || '').toLowerCase();

          // Hard auth failure → key is wrong, stop immediately
          if (resp.status === 401 || resp.status === 403 ||
              (resp.status === 400 && errMsg.includes('api key'))) {
            throw new Error(data.error?.message || `Auth error ${resp.status} — key rejected.`);
          }

          // Quota error → remember it and try next model
          if (resp.status === 429 || errMsg.includes('quota') || errMsg.includes('limit: 0') || errMsg.includes('rate limit')) {
            quotaHit = true;
            lastErr = data.error?.message || `Quota exceeded on ${model}`;
            continue;
          }

          // Model not found on this endpoint → skip silently
          if (resp.status === 404 || errMsg.includes('not found') || errMsg.includes('not supported')) {
            lastErr = lastErr || `${model} not available on this endpoint`;
            continue;
          }

          if (!resp.ok) { lastErr = data.error?.message || `Error ${resp.status}`; continue; }

          if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
            btn.textContent = `✅ ${model}`;
            btn.style.color = '#10B981';
            verified = true;
            break;
          }
        } catch (innerErr) {
          if (innerErr.message.includes('Auth error') || innerErr.message.includes('key rejected')) throw innerErr;
          lastErr = innerErr.message;
          continue;
        }
      }
      if (!verified) {
        // Quota was the real root cause — show actionable message
        if (quotaHit) {
          throw new Error(
            `Your Gemini API key is valid, but all free-tier models have hit their quota limit (limit: 0).\n\n` +
            `To fix this, enable billing on your Google Cloud project:\n` +
            `→ https://console.cloud.google.com/billing\n\n` +
            `Or get a fresh key from a new project at:\n` +
            `→ https://aistudio.google.com/app/apikey`
          );
        }
        throw new Error(lastErr || 'All Gemini models failed — please check your API key.');
      }
      return; // skip the generic ✅ below

    } else if (provider === 'openai') {
      const modelsToTry = ['gpt-4o-mini', 'gpt-3.5-turbo'];
      let oaiVerified = false;
      let oaiQuotaHit = false;
      let oaiLastErr = '';
      for (const model of modelsToTry) {
        btn.textContent = `⏳ Trying ${model}...`;
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${keyInput}` },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 })
        });
        const data = await resp.json();
        const errCode = data.error?.code || '';
        const errMsg  = data.error?.message || '';
        // Hard auth failure
        if (resp.status === 401) throw new Error(errMsg || 'Invalid API key — check your key.');
        // Quota / billing issue — key IS valid
        if (resp.status === 429 && (errCode === 'insufficient_quota' || errMsg.includes('quota'))) {
          oaiQuotaHit = true; oaiLastErr = errMsg; continue;
        }
        if (!resp.ok) { oaiLastErr = errMsg || `Error ${resp.status}`; continue; }
        oaiVerified = true;
        btn.textContent = `✅ ${model}`;
        btn.style.color = '#10B981';
        break;
      }
      if (!oaiVerified) {
        if (oaiQuotaHit) {
          throw new Error(
            `Your OpenAI key is valid ✓ but has no billing credits.\n\n` +
            `Add credits at:\n→ https://platform.openai.com/settings/billing\n\n` +
            `Even $5 gives ~500,000 tokens — plenty for rewriting.`
          );
        }
        throw new Error(oaiLastErr || 'OpenAI verification failed — check your key.');
      }
      return; // skip generic ✅

    } else if (provider === 'claude') {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': keyInput,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerously-allow-browser': 'true'
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          max_tokens: 5,
          messages: [{ role: 'user', content: 'Reply OK' }]
        })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error?.message || `Error ${resp.status}`);
    }

    btn.textContent = '✅ Valid';
    btn.style.color = '#10B981';
  } catch (e) {
    alert(`❌ ${provider} Key Error:\n\n${e.message}`);
    btn.textContent = '❌ Failed';
    btn.style.color = '#EF4444';
  } finally {
    setTimeout(() => {
      btn.textContent = originalText;
      btn.style.color = '';
      btn.disabled = false;
    }, 5000);
  }
};

// ─── Gemini API (streaming) ───────────────────────────────────────────────────
async function callGeminiStream(apiKey, systemPrompt, userPrompt, onChunk, signal, temperature = 0.7, useGrounding = false) {
  // 2.5-flash first — confirmed working via Python SDK when 1.5/2.0 hit limit: 0
  const modelsToTry = [
    'gemini-2.5-flash-preview-05-20',
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
  ];
  let lastErr = null;

  for (const model of modelsToTry) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
      
      const combinedPrompt = `[SYSTEM INSTRUCTION]\n${systemPrompt}\n\n[USER REQUEST]\n${userPrompt}`;
      
      const body = {
        contents: [{ role: 'user', parts: [{ text: combinedPrompt }] }],
        generationConfig: { temperature, topP: 0.95 },
      };
      // FIX: correct camelCase field name for Google Search grounding tool
      if (useGrounding) body.tools = [{ googleSearch: {} }];

      const resp = await fetch(url, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey 
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        const errMsg = err.error?.message || '';
        // On 404/quota/not-found, try the next model in the list
        if (resp.status === 404 || resp.status === 429 || errMsg.includes('not found') || errMsg.includes('quota') || errMsg.includes('deprecated')) {
          continue;
        }
        throw new Error(errMsg || `API error ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const dec    = new TextDecoder();
      let buf      = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const json  = JSON.parse(data);
            const token = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (token) onChunk(token);
          } catch {}
        }
      }
      return true; 
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = e;
      const msg = e.message.toLowerCase();
      if (msg.includes('key') || msg.includes('unauthorized') || msg.includes('api_key_invalid')) throw e;
    }
  }
  throw lastErr || new Error("All Gemini models failed. Please check your API key.");
}

// ─── OpenAI API (streaming) ───────────────────────────────────────────────────
async function callOpenAIStream(apiKey, systemPrompt, userPrompt, onChunk, signal, temperature = 0.7) {
  const url = 'https://api.openai.com/v1/chat/completions';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature,
      stream: true
    }),
    signal,
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenAI error ${resp.status}`);
  }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let full = '';
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const token = json.choices?.[0]?.delta?.content || '';
        if (token) { full += token; onChunk(token); }
      } catch {}
    }
  }
  return full;
}

// ─── Claude API (streaming - Note: subject to CORS) ───────────────────────────
async function callClaudeStream(apiKey, systemPrompt, userPrompt, onChunk, signal, temperature = 0.7) {
  const url = 'https://api.anthropic.com/v1/messages';
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerously-allow-browser': 'true'
    },
    body: JSON.stringify({
      model: 'claude-3-haiku-20240307',
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      temperature,
      max_tokens: 2000,
      stream: true
    }),
    signal,
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `Claude error ${resp.status}`);
  }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let full = '';
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      try {
        const json = JSON.parse(data);
        if (json.type === 'content_block_delta') {
          const token = json.delta?.text || '';
          if (token) { full += token; onChunk(token); }
        }
      } catch {}
    }
  }
  return full;
}

// ─── Prompts ──────────────────────────────────────────────────────────────────
function buildRewritePrompt(mode, tone, keywords) {
  const kw = keywords.length ? keywords.join(', ') : 'None specified.';
  const modeMap = { plagiarism: 'Remove Plagiarism', humanize: 'Humanize', both: 'Remove Plagiarism AND Humanize' };
  const label   = modeMap[mode] || 'Rewrite';

  let p = `You are an expert ghostwriter. Task: [${label}]. Tone: [${tone}].
RULES:
1. Preserve exact meaning. Do not add or remove facts.
2. Preserve ALL formatting (paragraphs, bullets, headings).
3. These keywords must appear EXACTLY as written: [${kw}]
4. Return ONLY the rewritten text. No preamble, no explanations.`;

  if (mode === 'plagiarism' || mode === 'both') {
    p += `\nPLAGIARISM REMOVAL:
- Restructure every sentence. Change word order, clause order, sentence structure.
- Replace all non-keyword verbs, adjectives, adverbs with synonyms.
- No 5+ word sequence should match the original.
- Change transitions, idioms, and paragraph openers completely.`;
  }

  if (mode === 'humanize' || mode === 'both') {
    p += `\nHUMANIZATION (CRITICAL — must pass AI detectors):
- BURSTINESS: Mix very short sentences (3-7 words) with long ones (20+ words). At least 25% under 8 words.
- PERPLEXITY: Unpredictable word choices. Use contractions (it's, don't, can't, there's).
- Start some sentences with: And, But, So, Now, Thing is,
- Use hedging: probably, arguably, in most cases, seems like, turns out
- Include dashes (—) and parenthetical asides (like this one).
- Use 1-2 sentence fragments. Like this.
- BANNED WORDS: delve, tapestry, testament, seamlessly, vital, crucial, pivotal, furthermore, moreover, in conclusion, leverage, harness, embark, navigate, synergy, robust, intricate, myriad, plethora, landscape, transformative, revolutionize, comprehensive, holistic, multifaceted, paradigm`;
  }

  return p;
}

function buildSecondPassPrompt() {
  return `You are a final-pass editor. Make the text more authentically human WITHOUT changing any meaning.
RULES: 1. Same meaning, same facts, same structure. 2. Add 2-3 more contractions. 3. Break up any uniform-length sentences. 4. Replace any remaining formal transitions with casual ones. 5. Return ONLY the edited text.`;
}

function buildSEOSystemPrompt() {
  return `You are a senior SEO strategist. Use Google Search to research the top ranking competitors for the given query. Then produce a CONCISE, scannable SEO intelligence report.

STRICT RULES:
- Use Markdown. Short bullet points only. One table.
- Each section: MAX 4-5 bullets. No padding. No filler.
- Total report: 400-600 words max.
- Be specific. Use real data from your search.

OUTPUT THIS EXACT STRUCTURE:

## 📊 Competitor Snapshot
| # | Domain | Focus | Strength |
|---|--------|-------|----------|

## 🔑 Top Keywords They Target
- (6-8 specific keywords, bold the most competitive ones)

## 📝 Content Patterns
- (heading structures, formats, avg word count)

## 🕳️ Gaps & Opportunities (Top 3)
- **Gap 1:** [topic they miss] — why it's an opportunity
- **Gap 2:** ...
- **Gap 3:** ...

## ✅ Top 5 Action Items
1. (most impactful first)
2. ...

No intro or outro.`;
}

function buildSEOUserPrompt(query, type) {
  return `Search type: ${type}\nTarget: ${query}\n\nSearch Google for the top 5 competing pages for this target. Analyze them and produce the SEO intelligence report.`;
}

// ─── Heuristic Scoring (offline) ──────────────────────────────────────────────
function scoreText(text) {
  if (!text || text.length < 50) return { ai: 0, orig: 100 };
  const words     = text.toLowerCase().match(/\b\w+\b/g) || [];
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 5);
  const wc        = words.length;

  const aiBanned = ['delve','tapestry','testament','seamlessly','furthermore','moreover',
    'pivotal','crucial','vital','robust','intricate','leverage','harness','navigate',
    'embark','synergy','multifaceted','comprehensive','holistic','transformative',
    'plethora','myriad','paradigm','landscape','in conclusion','it is worth noting'];
  const bannedHits = aiBanned.filter(w => text.toLowerCase().includes(w)).length;
  const phraseScore = Math.min(1, bannedHits / 4);

  const lengths = sentences.map(s => s.split(/\s+/).length);
  const mean    = lengths.reduce((a, b) => a + b, 0) / (lengths.length || 1);
  const variance = lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / (lengths.length || 1);
  const cv      = Math.sqrt(variance) / (mean || 1);
  const uniformScore = Math.max(0, 1 - cv / 0.7);

  const unique  = new Set(words).size;
  const ttr     = unique / (wc || 1);
  const vocabScore = Math.max(0, 1 - (ttr - 0.45) / 0.35);

  const aiRaw = phraseScore * 0.45 + uniformScore * 0.30 + vocabScore * 0.25;
  const aiScore   = Math.round(Math.min(100, Math.max(5, aiRaw * 100)));
  const origScore = 100 - aiScore;
  return { ai: aiScore, orig: origScore };
}

function updateInputScores() {
  const text = document.getElementById('input-text').value;
  const { ai, orig } = scoreText(text);
  setScores('in', ai, orig);
}
function updateOutputScores() {
  const text = document.getElementById('output-text').value;
  const { ai, orig } = scoreText(text);
  setScores('out', ai, orig);
}
function setScores(side, ai, orig) {
  const aiColor   = ai > 65 ? '#EF4444' : ai > 40 ? '#F59E0B' : '#10B981';
  const origColor = orig > 65 ? '#10B981' : orig > 40 ? '#F59E0B' : '#EF4444';
  document.getElementById(`${side}-ai-fill`).style.width  = ai + '%';
  document.getElementById(`${side}-ai-fill`).style.background  = aiColor;
  document.getElementById(`${side}-ai-val`).textContent   = ai + '%';
  document.getElementById(`${side}-ai-val`).style.color   = aiColor;
  document.getElementById(`${side}-orig-fill`).style.width = orig + '%';
  document.getElementById(`${side}-orig-fill`).style.background = origColor;
  document.getElementById(`${side}-orig-val`).textContent  = orig + '%';
  document.getElementById(`${side}-orig-val`).style.color  = origColor;
}
function resetScores() {
  ['in','out'].forEach(s => {
    ['ai','orig'].forEach(t => {
      document.getElementById(`${s}-${t}-fill`).style.width = '0';
      document.getElementById(`${s}-${t}-val`).textContent = '—';
    });
  });
  document.getElementById('in-words').textContent  = '0 words';
  document.getElementById('out-words').textContent = '0 words';
}

// ─── Markdown Renderer (lightweight) ─────────────────────────────────────────
function renderMarkdown(md) {
  // Step 1: escape HTML
  let html = md
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  // Step 2: block-level elements (order matters)
  html = html
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm,  '<h2>$1</h2>')
    .replace(/^# (.+)$/gm,   '<h1>$1</h1>')
    .replace(/^---$/gm, '<hr/>')
    // Tables
    .replace(/^\| (.+) \|$/gm, (row) => {
      const cells = row.slice(1,-1).split('|').map(c => `<td>${c.trim()}</td>`).join('');
      return `<tr>${cells}</tr>`;
    })
    .replace(/^(\|[-:| ]+)\|?$/gm, '') // remove separator rows
    // Lists
    .replace(/^[\-\*] (.+)$/gm, '<li>$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<li><span class="ol-num">$1.</span> $2</li>');

  // Step 3: group consecutive <tr> into <table>
  html = html.replace(/(<tr>.*<\/tr>\n?)+/gm, m => `<table>${m}</table>`);
  html = html.replace(/<\/table>\s*<table>/g, '');
  html = html.replace(/<tr>(<td>[-:]+<\/td>)+<\/tr>/g, '');
  // Make first row header
  html = html.replace(/<table>(<tr>)(.*?)(<\/tr>)/s, (_, open, content, close) => {
    const headerRow = content.replace(/<td>/g,'<th>').replace(/<\/td>/g,'</th>');
    return `<table>${open}${headerRow}${close}`;
  });

  // Step 4: group consecutive <li> into <ul>
  html = html.replace(/(<li>.*<\/li>\n?)+/gm, m => `<ul>${m}</ul>`);

  // Step 5: inline formatting
  html = html
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>');

  // Step 6: convert remaining plain-text lines into <p> blocks
  // Split by double newline (paragraph breaks), wrap non-block lines in <p>
  const blockTags = /^<(h[1-6]|ul|ol|table|hr|li)/;
  const parts = html.split(/\n{2,}/);
  html = parts.map(block => {
    block = block.trim();
    if (!block) return '';
    if (blockTags.test(block)) return block;
    // Convert single newlines inside a paragraph block to <br>
    return '<p>' + block.replace(/\n/g, '<br>') + '</p>';
  }).join('\n');

  return `<div class="md-report">${html}</div>`;
}

// ─── Yoast / RankMath special renderer ────────────────────────────────────────
function renderYoast(raw) {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  let kw = '', title = '', desc = '';
  for (const line of lines) {
    if (/^focus keyword:/i.test(line))   kw    = line.replace(/^focus keyword:\s*/i, '');
    else if (/^seo title:/i.test(line))  title = line.replace(/^seo title:\s*/i, '');
    else if (/^meta description:/i.test(line)) desc = line.replace(/^meta description:\s*/i, '');
    // fallback: some models omit the labels, just use lines in order
  }
  // Fallback if labels missing
  if (!kw && !title && !desc && lines.length >= 1) {
    kw = lines[0]; title = lines[1] || ''; desc = lines[2] || '';
  }
  const titleLen = title.length;
  const descLen  = desc.length;
  const titleColor = titleLen > 60 ? '#EF4444' : '#10B981';
  const descColor  = descLen  > 160 ? '#EF4444' : '#10B981';

  return `
  <div class="yoast-result">
    <div class="yr-field">
      <div class="yr-label">🔑 Focus Keyword</div>
      <div class="yr-value yr-kw">${escHtml(kw)}</div>
    </div>
    <div class="yr-field">
      <div class="yr-label">📄 SEO Title <span class="yr-len" style="color:${titleColor}">${titleLen}/60 chars</span></div>
      <div class="yr-value yr-title">${escHtml(title)}</div>
    </div>
    <div class="yr-field">
      <div class="yr-label">📝 Meta Description <span class="yr-len" style="color:${descColor}">${descLen}/160 chars</span></div>
      <div class="yr-value yr-desc">${escHtml(desc)}</div>
    </div>
    <div class="yr-copy-row">
      <button class="yr-copy-btn" onclick="copyYrField('${btoa(title)}', this)">📋 Copy Title</button>
      <button class="yr-copy-btn" onclick="copyYrField('${btoa(desc)}', this)">📋 Copy Description</button>
    </div>
  </div>`;
}
function escHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
window.copyYrField = (b64, btn) => {
  navigator.clipboard.writeText(atob(b64));
  const orig = btn.textContent;
  btn.textContent = '✅ Copied!';
  setTimeout(() => btn.textContent = orig, 2000);
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function countWords(text) {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}
function setSelectValue(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  for (const opt of el.options) if (opt.value === val || opt.text === val) { el.value = opt.value; return; }
}
function updateProviderBadge(provider) {
  const names = { gemini: '● Gemini', openai: '● OpenAI', claude: '● Claude' };
  const badge = document.getElementById('provider-badge');
  if (badge) badge.textContent = names[provider] || '● AI';
}

window.toggleKey = (id) => {
  const el = document.getElementById(id);
  el.type = el.type === 'password' ? 'text' : 'password';
};

// ─── Welcome Modal ───
window.closeWelcomeModal = () => {
  document.getElementById('welcome-modal').classList.add('hidden');
  localStorage.setItem('pencraftTourComplete', 'true');
};

// ═══════════════════════════════════════════════════════════════════════════════
//  BLOG STUDIO
// ═══════════════════════════════════════════════════════════════════════════════

let blogState = {
  topic: '', keywords: [], tone: '',
  titles: [], selectedIndices: [],
  currentBlogIdx: 0, rawBlogText: '',
};

// ─ Phase helpers ─────────────────────────────────────────────────────────────
function showBlogPhase(phase) {
  ['input', 'titles', 'output'].forEach(p =>
    document.getElementById(`blog-phase-${p}`).classList.toggle('hidden', p !== phase)
  );
}
window.blogGoBack = (phase) => showBlogPhase(phase);

// ─ Step 1: Generate Titles ───────────────────────────────────────────────────────
window.generateBlogTitles = async () => {
  const topic = document.getElementById('blog-topic').value.trim();
  const kws   = document.getElementById('blog-keywords').value.trim();
  const tone  = document.getElementById('blog-tone').value;
  if (!topic) { alert('Please enter a topic or project name first.'); return; }

  const btn = document.getElementById('btn-gen-titles');
  btn.textContent = '⏳ Generating titles...'; btn.disabled = true;

  blogState = { ...blogState, topic, tone,
    keywords: kws.split(',').map(k => k.trim()).filter(Boolean),
    titles: [], selectedIndices: [], currentBlogIdx: 0, rawBlogText: '' };

  const sys = `You are a world-class SEO content strategist specialising in real estate. Generate exactly 6 unique, compelling blog post titles.
RULES:
- Mix angles: listicle (numbers), question, how-to, buyer guide, data-driven, local SEO
- Include target keywords naturally in at least 4 titles
- Use power words: Best, Ultimate, Complete, Proven, Insider, Hidden
- Each title under 70 characters for SEO
- Output ONLY the 6 titles. One per line. No numbering, no quotes, no extra text.`;

  const usr = `Topic: ${topic}\nKeywords: ${blogState.keywords.join(', ')}\nTone: ${tone}\n\nGenerate 6 blog titles now.`;

  let raw = '';
  try {
    await aiGenerateWithFallback(sys, usr, c => { raw += c; }, new AbortController().signal, 0.92);
    blogState.titles = raw.split('\n').map(t => t.replace(/^[\d\.\-\*]+\s*/, '').trim()).filter(t => t.length > 15).slice(0, 6);
    if (!blogState.titles.length) throw new Error('No titles generated. Try again.');
    renderTitleCards();
    showBlogPhase('titles');
  } catch(e) {
    alert('❌ ' + e.message);
  } finally {
    btn.textContent = '✨ Generate 6 Title Options →'; btn.disabled = false;
  }
};

function renderTitleCards() {
  blogState.selectedIndices = [];
  const list = document.getElementById('blog-titles-list');
  list.innerHTML = blogState.titles.map((title, i) => `
    <div class="blog-title-card" id="btc-${i}" onclick="toggleBlogTitle(${i})">
      <div class="btc-check" id="btc-chk-${i}">✓</div>
      <div class="btc-body">
        <div class="btc-text">${escHtml(title)}</div>
        <div class="btc-meta">~900 words · SEO Optimised · AI-Undetectable</div>
      </div>
    </div>
  `).join('');
  document.getElementById('blog-sel-count').textContent = '0 selected';
  document.getElementById('btn-gen-blogs').disabled = true;
}

window.toggleBlogTitle = (i) => {
  const card = document.getElementById(`btc-${i}`);
  const isSelected = card.classList.toggle('selected');
  if (isSelected) blogState.selectedIndices.push(i);
  else blogState.selectedIndices = blogState.selectedIndices.filter(x => x !== i);
  const n = blogState.selectedIndices.length;
  document.getElementById('blog-sel-count').textContent =
    n === 0 ? '0 selected' : `${n} title${n > 1 ? 's' : ''} selected`;
  document.getElementById('btn-gen-blogs').disabled = n === 0;
};

// ─ Step 2: Generate Blogs ───────────────────────────────────────────────────────
window.generateSelectedBlogs = () => {
  blogState.currentBlogIdx = 0;
  showBlogPhase('output');
  _generateCurrentBlog();
};

async function _generateCurrentBlog() {
  const idx   = blogState.selectedIndices[blogState.currentBlogIdx];
  const title = blogState.titles[idx];
  const total = blogState.selectedIndices.length;
  const curr  = blogState.currentBlogIdx + 1;
  const { topic, keywords, tone } = blogState;

  // Update nav
  document.getElementById('blog-nav-label').textContent = `Blog ${curr} of ${total}`;
  document.getElementById('blog-nav-title').textContent = title;
  document.getElementById('btn-next-blog').style.display = 'none';
  document.getElementById('btn-copy-blog').style.display = 'none';

  const contentEl = document.getElementById('blog-output-content');
  contentEl.innerHTML = `<div class="blog-generating">
    <div class="blog-gen-spinner"></div>
    <div class="blog-gen-status" id="blog-gen-status">✍ Initialising AI writer...</div>
    <div class="blog-gen-stream" id="blog-gen-stream"></div>
  </div>`;

  const kwStr = keywords.length ? keywords.join(', ') : 'general terms';
  const sys = _buildBlogSystemPrompt(tone);
  const usr = `Title: "${title}"
Topic: ${topic}
Keywords to retain (bold these where natural): ${kwStr}
Tone: ${tone}

Write the complete, fully humanized, SEO-optimized blog post now. Follow the exact structure from your instructions. Do NOT add any preamble.`;

  let raw = '';
  let firstChunk = true;
  try {
    await aiGenerateWithFallback(sys, usr, (chunk) => {
      raw += chunk;
      const streamEl = document.getElementById('blog-gen-stream');
      const statusEl = document.getElementById('blog-gen-status');
      if (streamEl) {
        if (firstChunk) { statusEl.textContent = '✍ Writing...'; firstChunk = false; }
        streamEl.textContent = raw.slice(-600); // show last 600 chars while streaming
      }
    }, new AbortController().signal, 0.96);

    blogState.rawBlogText = raw;
    // Render final output
    contentEl.innerHTML = renderBlogPost(raw, keywords);
    document.getElementById('btn-copy-blog').style.display = '';
    if (curr < total) document.getElementById('btn-next-blog').style.display = '';

  } catch(e) {
    contentEl.innerHTML = `<p style="color:#EF4444;padding:32px">❌ ${e.message}</p>`;
  }
}

window.nextBlog = () => {
  blogState.currentBlogIdx++;
  _generateCurrentBlog();
};

window.copyBlogContent = () => {
  if (!blogState.rawBlogText) return;
  const clean = blogState.rawBlogText
    .replace(/\*\*/g, '').replace(/\*/g, '')
    .replace(/^#+\s+/gm, ''); // strip ## for clean WP paste
  navigator.clipboard.writeText(clean);
  const btn = document.getElementById('btn-copy-blog');
  btn.textContent = '✅ Copied!';
  setTimeout(() => btn.textContent = '📋 Copy', 2000);
};

// ─ Blog System Prompt ───────────────────────────────────────────────────────────
function _buildBlogSystemPrompt(tone) {
  return `You are an expert blog writer, SEO specialist and humanizer. Your writing is COMPLETELY indistinguishable from human writing — it passes GPTZero, Originality.ai, Copyleaks, and all other AI detectors at 0% AI score.

HUMANIZATION RULES (NON-NEGOTIABLE):
1. BURSTINESS — at least 35% of sentences must be under 8 words. Mix very short (3-6 words) with long (25+ words).
2. PERPLEXITY — use surprising, unpredictable word choices. Never use the same transition twice in the whole post.
3. CONTRACTIONS — use it's, don't, can't, there's, you'll, we've, isn't, they're, here's naturally throughout.
4. SENTENCE STARTERS — begin 25% of sentences with: And, But, So, Now, Here's the thing, Honestly, Look,
5. EM-DASHES — use em-dashes (—) and parenthetical asides (like this) at least 5 times.
6. FRAGMENTS — include 3-4 intentional one-sentence fragments. Like this. For effect.
7. HEDGING — use: probably, in most cases, generally speaking, from what we've seen, seems like
8. BANNED WORDS — NEVER use: delve, tapestry, testament, seamlessly, vital, crucial, pivotal, furthermore, moreover, in conclusion, leverage, harness, embark, navigate, synergy, robust, intricate, myriad, plethora, landscape, transformative, revolutionize, comprehensive, holistic, multifaceted, paradigm, meticulous, it is worth noting, look no further

SEO RULES:
- Primary keyword appears in: H1, first 100 words, at least 2 H2s, conclusion
- Keyword density 1-2% (not stuffed)
- All headings are benefit-driven, not just descriptive
- Bold target keywords when they first appear in each section

OUTPUT STRUCTURE — follow EXACTLY, no deviations:

# [Title — same as given]

## 📋 Table of Contents
1. Introduction
2. [Section 2 name]
3. [Section 3 name]
4. [Section 4 name]
5. [Section 5 name]
6. Key Takeaways
7. FAQs
8. Conclusion

## 💡 Key Takeaways
- [Takeaway 1 — specific, actionable]
- [Takeaway 2]
- [Takeaway 3]
- [Takeaway 4]
- [Takeaway 5]

## Introduction
[250-300 words. Hook in first sentence. No "In today's world" or "In this article". State the problem the reader faces. End with a promise of what they'll learn. Must be highly engaging.]

## [Section 2 heading — benefit-driven]
[300-350 words. Deep dive with data, specifics, examples. Bold the primary keyword on first mention. Use sub-bullets if needed.]

## [Section 3 heading — benefit-driven]
[300-350 words. Different angle. Focus on ROI, lifestyle, or core features. Include a short numbered list.]

## [Section 4 heading — data or local angle]
[300-350 words. Include specific numbers, prices, locations, or statistics where relevant. Ground the content in reality.]

## [Section 5 heading — expert insights or future outlook]
[250-300 words. Provide forward-looking advice, expert tips, or market trends. Establish strong authority.]

## ❓ Frequently Asked Questions

**Q: [Common question readers search for]**
A: [Concise 2-3 sentence answer optimised for featured snippets]

**Q: [Second question]**
A: [Answer]

**Q: [Third question]**
A: [Answer]

**Q: [Fourth question]**
A: [Answer]

**Q: [Fifth question]**
A: [Answer]

## Conclusion
[150-200 words. Natural, warm close. Summarize the core message. Soft CTA. Do NOT start with "In conclusion". No generic sign-offs.]

---

**🎯 Meta Description:** [Under 160 chars. Include primary keyword. End with soft CTA.]
**🔑 Focus Keyword:** [Single primary keyword]
**📊 Word Count:** ~1600 words (Must be over 1500 words)

TONE: ${tone}

NOW WRITE THE COMPLETE BLOG POST. It MUST be at least 1500 words. No preamble, no explanation, start directly with # [Title]`;
}

// ─ Blog Post Renderer ──────────────────────────────────────────────────────────
function renderBlogPost(md, keywords) {
  // Base markdown rendering
  let html = renderMarkdown(md);

  // Keyword highlighting (skip inside HTML tags)
  if (keywords && keywords.length) {
    keywords.forEach(kw => {
      if (!kw || kw.length < 3) return;
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Only highlight text nodes (not inside tags)
      html = html.replace(
        new RegExp(`(?<![\\w>])(?<!<[^>]*)(${escaped})(?![\\w])(?![^<]*>)`, 'gi'),
        '<mark class="kw-hl">$1</mark>'
      );
    });
  }

  // Pull out meta box (everything after ---)
  const metaSplit = html.indexOf('<hr');
  let mainHtml = html;
  let metaHtml = '';
  if (metaSplit !== -1) {
    mainHtml = html.slice(0, metaSplit);
    metaHtml = html.slice(metaSplit);
  }

  // Build meta card from the trailing content
  const metaCard = metaHtml
    ? `<div class="blog-meta-card">${metaHtml}</div>`
    : '';

  return `<div class="blog-rendered">${mainHtml}${metaCard}</div>`;
}

// ─── Welcome Modal ───
window.closeWelcomeModal = () => {
  document.getElementById('welcome-modal').classList.add('hidden');
  localStorage.setItem('pencraftTourComplete', 'true');
};
