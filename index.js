import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

// 扩展配置：按实际安装文件夹自动识别，避免仓库名改了以后找不到 example.html
const extensionFolderPath = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const extensionName = decodeURIComponent(extensionFolderPath.split("/").pop() || "sillytavern-siliconflow-tts");

// 全局状态管理
const audioState = {
  isPlaying: false,
  currentAudio: null,      // 当前播放的音频对象，用于随时停止
  playingButton: null,     // 当前发亮的喇叭按钮
  lastProcessedMessageId: null,
  lastProcessedUserMessageId: null,
  processingTimeout: null,
  audioQueue: []
};

// TTS 音频缓存：同一段文字只生成一次，之后“再听一次”直接放缓存，不再请求 API（不扣费）
const ttsAudioCache = new Map();

// ===== 屏幕日志面板：每步都打出来，方便排查 =====
function ttsLog(msg) {
  const t = new Date().toLocaleTimeString();
  const line = "[" + t + "] " + msg;
  try { console.log("[TTS]", line); } catch (e) {}
  let panel = document.getElementById("tts-log-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "tts-log-panel";
    panel.style.cssText =
      "position:fixed;left:8px;top:8px;z-index:100500;width:min(300px,calc(100vw - 16px));max-width:calc(100vw - 16px);max-height:min(170px,32vh);overflow-y:auto;" +
      "background:rgba(0,0,0,0.88);color:#00ff7f;font-size:10px;line-height:1.45;padding:0;border-radius:8px;" +
      "font-family:monospace;white-space:pre-wrap;display:none;box-shadow:0 2px 12px rgba(0,0,0,0.6);";
    const head = document.createElement("div");
    head.style.cssText = "position:sticky;top:0;background:#111;color:#fff;padding:4px 8px;display:flex;justify-content:space-between;align-items:center;border-radius:8px 8px 0 0;";
    const title = document.createElement("span");
    title.textContent = "TTS 日志";
    const btns = document.createElement("span");
    const clr = document.createElement("span");
    clr.textContent = "清空";
    clr.style.cssText = "cursor:pointer;margin-right:14px;color:#ffd54a;";
    clr.onclick = () => { const b = document.getElementById("tts-log-body"); if (b) b.innerHTML = ""; };
    const cls = document.createElement("span");
    cls.textContent = "✕";
    cls.style.cssText = "cursor:pointer;color:#fff;";
    cls.onclick = () => { panel.style.display = "none"; };
    btns.appendChild(clr); btns.appendChild(cls);
    head.appendChild(title); head.appendChild(btns);
    const body = document.createElement("div");
    body.id = "tts-log-body";
    body.style.cssText = "padding:6px 8px;";
    panel.appendChild(head);
    panel.appendChild(body);
    document.body.appendChild(panel);
  }
  // 不再自动弹出，只静默记录；用播放条上的「日志」按钮打开/收起
  const body = document.getElementById("tts-log-body");
  const div = document.createElement("div");
  div.textContent = line;
  body.appendChild(div);
  while (body.childNodes.length > 60) body.removeChild(body.firstChild);
  body.scrollTop = body.scrollHeight;
}



// 默认设置
const DEFAULT_TTS_MAX_CHARS = 1000;

const defaultSettings = {
  apiKey: "",
  apiUrl: "https://api.siliconflow.cn/v1",
  ttsModel: "FunAudioLLM/CosyVoice2-0.5B",
  ttsVoice: "alex",
  ttsSpeed: 1.0,
  ttsGain: 0,
  responseFormat: "mp3",
  sampleRate: 32000,
  imageModel: "",
  imageSize: "512",
  textStart: "\"",
  textEnd: "\"",
  symbolReadInside: true,
  symbolReadOutside: true,
  symbolOutsideStart: "（ 【",
  symbolOutsideEnd: "） 】",
  extraTextRulesEnabled: false,
  skipTagPairs: [],
  readTagPairs: [],
  readUntaggedWithRequired: false,
  ttsMaxReadChars: DEFAULT_TTS_MAX_CHARS,
  generationFrequency: 5,
  autoPlay: true,
  autoPlayUser: false,
  barPersistent: true,
  playerBarSize: "small",
  ttsPlaybackRate: 1.0,
  roleVoiceMap: {},
  customVoices: [] // 存储自定义音色列表
};

// TTS模型和音色配置
const TTS_MODELS = {
  "FunAudioLLM/CosyVoice2-0.5B": {
    name: "CosyVoice2-0.5B",
    voices: {
      "alex": "Alex (男声)",
      "anna": "Anna (女声)",
      "bella": "Bella (女声)",
      "benjamin": "Benjamin (男声)",
      "charles": "Charles (男声)",
      "claire": "Claire (女声)",
      "david": "David (男声)",
      "diana": "Diana (女声)"
    }
  }
};

function normalizeTagPairs(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(pair => ({
      start: String(pair?.start || "").trim(),
      end: String(pair?.end || "").trim(),
      enabled: pair?.enabled !== false,
    }))
    .filter(pair => pair.start && pair.end);
}

function getTtsMaxReadChars() {
  const uiValue = $("#tts_max_read_chars").length ? Number.parseInt($("#tts_max_read_chars").val(), 10) : NaN;
  const savedValue = Number.parseInt(extension_settings[extensionName]?.ttsMaxReadChars, 10);
  const candidate = Number.isFinite(uiValue) && uiValue > 0 ? uiValue
    : Number.isFinite(savedValue) && savedValue > 0 ? savedValue
      : DEFAULT_TTS_MAX_CHARS;
  return Math.max(1, candidate);
}

function getEnabledTagPairs(value) {
  return normalizeTagPairs(value).filter(pair => pair.enabled !== false);
}

function makeEndTagFromStart(startTag) {
  const tag = String(startTag || "").trim();
  if (!tag) return "";
  const match = tag.match(/^<\s*([^\s>/]+)[^>]*>$/);
  if (match) return `</${match[1]}>`;
  if (tag.startsWith("<") && !tag.startsWith("</")) return tag.replace(/^<\s*/, "</");
  return "";
}

function getTagPairSettingKey(kind) {
  return kind === "skip" ? "skipTagPairs" : "readTagPairs";
}

function collectTagPairSettings(kind) {
  const pairs = [];
  $(`.tts-tag-pair-row[data-kind="${kind}"]`).each(function () {
    const start = $(this).find(".tts-tag-start").val().trim();
    const end = $(this).find(".tts-tag-end").val().trim();
    const enabled = $(this).find(".tts-tag-enabled").prop("checked") !== false;
    if (start || end) pairs.push({ start, end: end || makeEndTagFromStart(start), enabled });
  });
  return normalizeTagPairs(pairs);
}

function addTagPairRow(kind, pair = {}) {
  const container = $(`#tts_${kind}_tag_pairs`);
  if (container.length === 0) return;
  const row = $(`
    <div class="setting-item button-group tts-tag-pair-row" data-kind="${kind}">
      <span class="tts-tag-status ${kind === "skip" ? "tts-tag-skip" : "tts-tag-read"}">${kind === "skip" ? "×" : "✓"}</span>
      <label class="tts-tag-enabled-label"><input type="checkbox" class="tts-tag-enabled" title="启用这一组" checked><span>启用</span></label>
      <label>开始:<input type="text" class="tts-tag-start" placeholder="<think>"></label>
      <label>结束:<input type="text" class="tts-tag-end" placeholder="</think>"></label>
      <span class="tts-tag-preview"></span>
      <button type="button" class="menu_button tts-tag-remove" title="删除这一组">-</button>
    </div>
  `);
  row.find(".tts-tag-start").val(pair.start || "");
  row.find(".tts-tag-end").val(pair.end || makeEndTagFromStart(pair.start));
  row.find(".tts-tag-enabled").prop("checked", pair.enabled !== false);
  row.attr("data-auto-end", makeEndTagFromStart(pair.start));
  container.append(row);
  updateTagPairPreview(row);
}

function updateTagPairPreview(row) {
  const start = row.find(".tts-tag-start").val().trim();
  const end = row.find(".tts-tag-end").val().trim();
  row.find(".tts-tag-preview").text(start && end ? `${start}  ${end}` : "");
}

function renderTagPairSettings(kind) {
  const container = $(`#tts_${kind}_tag_pairs`);
  if (container.length === 0) return;
  container.empty();
  const pairs = normalizeTagPairs(extension_settings[extensionName][getTagPairSettingKey(kind)]);
  pairs.forEach(pair => addTagPairRow(kind, pair));
}

function updateExtraTextRulesUI(enabled = extension_settings[extensionName]?.extraTextRulesEnabled === true) {
  $("#tts_enable_extra_text_rules").prop("checked", !!enabled);
  $(".sf-extra-text-rules-body").toggle(!!enabled);
}

// 加载设置
async function loadSettings() {
  extension_settings[extensionName] = extension_settings[extensionName] || {};
  
  if (Object.keys(extension_settings[extensionName]).length === 0) {
    Object.assign(extension_settings[extensionName], defaultSettings);
  }
  Object.keys(defaultSettings).forEach((key) => {
    if (extension_settings[extensionName][key] === undefined) {
      extension_settings[extensionName][key] = defaultSettings[key];
    }
  });
  if (extension_settings[extensionName].textStart === "（") {
    extension_settings[extensionName].textStart = defaultSettings.textStart;
  }
  if (extension_settings[extensionName].textEnd === "）") {
    extension_settings[extensionName].textEnd = defaultSettings.textEnd;
  }
  if (extension_settings[extensionName].textStart === "（ 【 \"" && extension_settings[extensionName].textEnd === "） 】 \"") {
    extension_settings[extensionName].textStart = defaultSettings.textStart;
    extension_settings[extensionName].textEnd = defaultSettings.textEnd;
    extension_settings[extensionName].symbolReadOutside = true;
    extension_settings[extensionName].symbolOutsideStart = defaultSettings.symbolOutsideStart;
    extension_settings[extensionName].symbolOutsideEnd = defaultSettings.symbolOutsideEnd;
  }

  // 更新UI
  $("#siliconflow_api_key").val(extension_settings[extensionName].apiKey || "");
  $("#siliconflow_api_url").val(extension_settings[extensionName].apiUrl || defaultSettings.apiUrl);
  $("#tts_model").val(extension_settings[extensionName].ttsModel || defaultSettings.ttsModel);
  $("#tts_voice").val(extension_settings[extensionName].ttsVoice || defaultSettings.ttsVoice);
  $("#tts_speed").val(extension_settings[extensionName].ttsSpeed || defaultSettings.ttsSpeed);
  $("#tts_speed_value").text(extension_settings[extensionName].ttsSpeed || defaultSettings.ttsSpeed);
  $("#tts_gain").val(extension_settings[extensionName].ttsGain || defaultSettings.ttsGain);
  $("#tts_gain_value").text(extension_settings[extensionName].ttsGain || defaultSettings.ttsGain);
  $("#response_format").val(extension_settings[extensionName].responseFormat || defaultSettings.responseFormat);
  $("#sample_rate").val(extension_settings[extensionName].sampleRate || defaultSettings.sampleRate);
  $("#image_size").val(extension_settings[extensionName].imageSize || defaultSettings.imageSize);
  $("#image_text_start").val(extension_settings[extensionName].textStart || defaultSettings.textStart);
  $("#image_text_end").val(extension_settings[extensionName].textEnd || defaultSettings.textEnd);
  $("#tts_read_symbol_inside").prop("checked", extension_settings[extensionName].symbolReadInside !== false);
  $("#tts_read_symbol_outside").prop("checked", extension_settings[extensionName].symbolReadOutside === true);
  $("#tts_symbol_outside_start").val(extension_settings[extensionName].symbolOutsideStart || defaultSettings.symbolOutsideStart);
  $("#tts_symbol_outside_end").val(extension_settings[extensionName].symbolOutsideEnd || defaultSettings.symbolOutsideEnd);
  $("#tts_max_read_chars").val(extension_settings[extensionName].ttsMaxReadChars || defaultSettings.ttsMaxReadChars);
  $("#generation_frequency").val(extension_settings[extensionName].generationFrequency || defaultSettings.generationFrequency);
  $("#auto_play_audio").prop("checked", extension_settings[extensionName].autoPlay !== false);
  $("#auto_play_user").prop("checked", extension_settings[extensionName].autoPlayUser === true);
  $("#tts_enable_extra_text_rules").prop("checked", extension_settings[extensionName].extraTextRulesEnabled === true);
  $("#tts_read_untagged_with_required").prop("checked", extension_settings[extensionName].readUntaggedWithRequired === true);
  renderTagPairSettings("skip");
  renderTagPairSettings("read");
  updateExtraTextRulesUI();
  updateSymbolConflictUI();
  
  updateVoiceOptions();
}

// 更新音色选项
function updateVoiceOptions() {
  const model = $("#tts_model").val();
  const voiceSelect = $("#tts_voice");
  const currentValue = voiceSelect.val();
  voiceSelect.empty();
  
  // 添加预设音色
  if (TTS_MODELS[model] && TTS_MODELS[model].voices) {
    voiceSelect.append('<optgroup label="预设音色">');
    Object.entries(TTS_MODELS[model].voices).forEach(([value, name]) => {
      voiceSelect.append(`<option value="${value}">${name}</option>`);
    });
    voiceSelect.append('</optgroup>');
  }
  
  // 添加自定义音色
  const customVoices = extension_settings[extensionName].customVoices || [];
  console.log(`更新音色选项，自定义音色数量: ${customVoices.length}`);
  
  if (customVoices.length > 0) {
    voiceSelect.append('<optgroup label="自定义音色">');
    customVoices.forEach(voice => {
      // 尝试不同的字段名称
      const voiceName = voice.name || voice.customName || voice.custom_name || "未命名";
      const voiceUri = voice.uri || voice.id || voice.voice_id;
      console.log(`添加自定义音色: ${voiceName} -> ${voiceUri}`);
      voiceSelect.append(`<option value="${voiceUri}">${voiceName} (自定义)</option>`);
    });
    voiceSelect.append('</optgroup>');
  }
  
  // 恢复之前的选择或设置默认值
  if (currentValue && voiceSelect.find(`option[value="${currentValue}"]`).length > 0) {
    voiceSelect.val(currentValue);
  } else {
    voiceSelect.val(extension_settings[extensionName].ttsVoice || Object.keys(TTS_MODELS[model]?.voices || {})[0]);
  }
  renderRoleVoiceMap();
}

function escapeHtml(text) {
  return String(text || "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function getAllVoiceOptions() {
  const model = $("#tts_model").val() || extension_settings[extensionName]?.ttsModel || defaultSettings.ttsModel;
  const options = [];
  if (TTS_MODELS[model]?.voices) {
    Object.entries(TTS_MODELS[model].voices).forEach(([value, label]) => options.push({ value, label }));
  }
  (extension_settings[extensionName]?.customVoices || []).forEach(voice => {
    const label = voice.name || voice.customName || voice.custom_name || "未命名";
    const value = voice.uri || voice.id || voice.voice_id;
    if (value) options.push({ value, label: `${label} (自定义)` });
  });
  return options;
}

function isTemplateSpeakerName(name) {
  const text = String(name || "").trim();
  return /^\$\{[^}]+\}$/.test(text);
}

function collectCurrentChatSpeakers() {
  const context = getContext();
  const chat = Array.isArray(context?.chat) ? context.chat : [];
  const names = [];
  chat.forEach(message => {
    if (!message || message.is_user) return;
    const name = String(message.name || message.extra?.display_name || "").trim();
    if (name && !isTemplateSpeakerName(name) && !names.includes(name)) names.push(name);
  });
  $(".mes").each(function () {
    const name = $(this).find(".name_text").first().text().trim();
    if (name && !isTemplateSpeakerName(name) && !names.includes(name)) names.push(name);
  });
  return names;
}

function renderRoleVoiceMap(names = collectCurrentChatSpeakers()) {
  const container = $("#tts_role_voice_map");
  if (container.length === 0) return;
  const roleVoiceMap = extension_settings[extensionName].roleVoiceMap || {};
  const voiceOptions = getAllVoiceOptions();
  if (!names.length) {
    container.html('<small>当前聊天还没有读到角色消息。打开角色聊天页后点“刷新当前聊天角色”。</small>');
    return;
  }
  const optionHtml = (selected) => [
    '<option value="">使用默认语音角色</option>',
    ...voiceOptions.map(opt => `<option value="${escapeHtml(opt.value)}"${opt.value === selected ? " selected" : ""}>${escapeHtml(opt.label)}</option>`),
  ].join("");
  container.html(names.map(name => `
    <div class="setting-item button-group sf-role-voice-row" data-role-name="${escapeHtml(name)}">
      <span class="sf-role-name">${escapeHtml(name)}</span>
      <select class="tts-role-voice-select">${optionHtml(roleVoiceMap[name] || "")}</select>
    </div>
  `).join(""));
}

function getMessageSpeakerName(messageElement) {
  const mesId = Number.parseInt(messageElement.attr("mesid"), 10);
  const context = getContext();
  const message = Number.isFinite(mesId) ? context?.chat?.[mesId] : null;
  return String(message?.name || message?.extra?.display_name || messageElement.find(".name_text").first().text() || "").trim();
}

function getVoiceForSpeaker(speakerName) {
  const fallback = $("#tts_voice").val() || extension_settings[extensionName].ttsVoice || defaultSettings.ttsVoice;
  if (!speakerName || isTemplateSpeakerName(speakerName)) return fallback;
  const mapped = extension_settings[extensionName].roleVoiceMap?.[speakerName];
  return mapped || fallback;
}

// 保存设置
function saveSettings() {
  extension_settings[extensionName].apiKey = $("#siliconflow_api_key").val();
  extension_settings[extensionName].apiUrl = $("#siliconflow_api_url").val();
  extension_settings[extensionName].ttsModel = $("#tts_model").val();
  extension_settings[extensionName].ttsVoice = $("#tts_voice").val();
  extension_settings[extensionName].ttsSpeed = parseFloat($("#tts_speed").val());
  extension_settings[extensionName].ttsGain = parseFloat($("#tts_gain").val());
  extension_settings[extensionName].responseFormat = $("#response_format").val();
  extension_settings[extensionName].sampleRate = parseInt($("#sample_rate").val());
  extension_settings[extensionName].imageSize = $("#image_size").val();
  extension_settings[extensionName].textStart = $("#image_text_start").val();
  extension_settings[extensionName].textEnd = $("#image_text_end").val();
  extension_settings[extensionName].symbolReadInside = $("#tts_read_symbol_inside").prop("checked") === true;
  extension_settings[extensionName].symbolReadOutside = $("#tts_read_symbol_outside").prop("checked") === true;
  extension_settings[extensionName].symbolOutsideStart = $("#tts_symbol_outside_start").val();
  extension_settings[extensionName].symbolOutsideEnd = $("#tts_symbol_outside_end").val();
  extension_settings[extensionName].ttsMaxReadChars = getTtsMaxReadChars();
  extension_settings[extensionName].extraTextRulesEnabled = $("#tts_enable_extra_text_rules").prop("checked") === true;
  extension_settings[extensionName].skipTagPairs = collectTagPairSettings("skip");
  extension_settings[extensionName].readTagPairs = collectTagPairSettings("read");
  extension_settings[extensionName].readUntaggedWithRequired = $("#tts_read_untagged_with_required").prop("checked") === true;
  extension_settings[extensionName].generationFrequency = parseInt($("#generation_frequency").val());
  extension_settings[extensionName].autoPlay = $("#auto_play_audio").prop("checked");
  extension_settings[extensionName].autoPlayUser = $("#auto_play_user").prop("checked");
  
  saveSettingsDebounced();
  // 移除弹窗提示，改为控制台日志
  console.log("设置已保存");
}

// 测试连接
async function testConnection() {
  const apiKey = $("#siliconflow_api_key").val();
  
  if (!apiKey) {
    toastr.error("请先输入API密钥", "连接失败");
    return;
  }
  
  try {
    // 获取音色列表作为连接测试
    const response = await fetch(`${extension_settings[extensionName].apiUrl}/audio/voice/list`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (response.ok) {
      // 只更新状态，不显示弹窗
      $("#connection_status").text("已连接").css("color", "green");
      console.log("API连接成功");
    } else {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    toastr.error(`连接失败: ${error.message}`, "硅基流动插件");
    $("#connection_status").text("未连接").css("color", "red");
  }
}

// TTS功能
async function generateTTS(text, buttonElement = null, voiceOverride = null) {
  const apiKey = extension_settings[extensionName].apiKey;
  
  if (!apiKey) {
    ttsLog("❌ 没有配置 API 密钥");
    toastr.error("请先配置API密钥", "TTS错误");
    return;
  }
  
  if (!text) {
    ttsLog("❌ 文本为空，不请求");
    toastr.error("文本不能为空", "TTS错误");
    return;
  }

  ttsLog("① 进入生成，文本长度 " + text.length + "：「" + text.substring(0, 30) + "」");

  // 先熄灭其它按钮，再把当前按钮立刻点亮成“生成中（黄）”——任何一次点击都能马上看到反馈
  $(".tts-manual-play-btn").removeClass("tts-loading tts-playing");
  if (buttonElement && buttonElement.length > 0) {
    audioState.playingButton = buttonElement;
    setButtonState(buttonElement, "loading");
  }

  const voiceValue = voiceOverride || $("#tts_voice").val() || "alex";
  const speed = parseFloat($("#tts_speed").val()) || 1.0;
  const gain = parseFloat($("#tts_gain").val()) || 0;
  const cacheKey = JSON.stringify({ text, voice: voiceValue, speed, gain });

  // 命中缓存：同一段文字 + 同一音色 + 同一语速音量，直接播放，不再请求 API（不扣费）
  if (ttsAudioCache.has(cacheKey)) {
    ttsLog("② 命中缓存，直接播放（不扣费）");
    playAudioUrl(ttsAudioCache.get(cacheKey), buttonElement);
    return ttsAudioCache.get(cacheKey);
  }
  
  try {
    console.log("正在生成语音...");

    // 安全上限：默认 1000 字；用户在「全文发送上限」填写更高/更低数字时，以用户填写为准
    const MAX_LEN = getTtsMaxReadChars();
    if (text.length > MAX_LEN) {
      console.warn(`文本过长(${text.length})，已截断到 ${MAX_LEN} 字`);
      text = text.substring(0, MAX_LEN);
      ttsLog(`✂ 文本超过全文发送上限，已按 ${MAX_LEN} 字截断`);
      toastr.info(`文本较长，已按全文发送上限 ${MAX_LEN} 字朗读`, "TTS");
    }

    let voiceParam;
    if (voiceValue.startsWith("speech:")) {
      voiceParam = voiceValue;
    } else {
      voiceParam = `FunAudioLLM/CosyVoice2-0.5B:${voiceValue}`;
    }
    
    const requestBody = {
      model: "FunAudioLLM/CosyVoice2-0.5B",
      input: text,
      voice: voiceParam,
      response_format: "mp3",
      speed: speed,
      gain: gain
    };
    ttsLog("③ 请求 API 中… 音色=" + voiceParam);

    // 45 秒超时，避免无限卡在“生成中”
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);

    let response;
    try {
      response = await fetch(`${extension_settings[extensionName].apiUrl}/audio/speech`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
    } catch (e) {
      clearTimeout(timeoutId);
      if (e.name === 'AbortError') {
        throw new Error('请求超时（45秒）。可能文本太长或网络问题，换短一点的内容试试。');
      }
      throw e;
    }
    clearTimeout(timeoutId);

    ttsLog("④ API 返回 HTTP " + response.status);

    if (!response.ok) {
      const errText = await response.text();
      ttsLog("❌ API 报错：" + errText.substring(0, 120));
      throw new Error(`HTTP ${response.status}: ${errText}`);
    }
    
    const audioBlob = await response.blob();
    const audioUrl = URL.createObjectURL(audioBlob);
    ttsLog("⑤ 拿到音频 " + (audioBlob.size / 1024).toFixed(1) + " KB");

    // 存入缓存，下次同一段文字直接放，不再扣费
    ttsAudioCache.set(cacheKey, audioUrl);

    playAudioUrl(audioUrl, buttonElement);

    const fmt = extension_settings[extensionName].responseFormat || "mp3";
    const downloadLink = $(`<a href="${audioUrl}" download="tts_output.${fmt}">下载音频</a>`);
    $("#tts_output").empty().append(downloadLink);
    
    console.log("语音生成成功！");
    return audioUrl;
  } catch (error) {
    resetPlayState();
    ttsLog("❌ 出错：" + (error && error.message ? error.message : error));
    console.error("TTS Error:", error);
    toastr.error(`语音生成失败: ${error.message}`, "TTS错误");
  }
}

// 实际播放一个音频URL（缓存和新生成共用）
// ===== 移动端音频解锁 + 底部“一定能出声”播放条 =====
let ttsAudioEl = null;
let audioPrimed = false;
let silentAudioUrl = null;
let lastTtsAudioUrl = "";
let lastTtsDownloadName = "tts_output.mp3";
let playerBarDragged = false;
let playerBarAnchorElement = null;

function shouldKeepPlayerBarVisible() {
  return extension_settings[extensionName]?.barPersistent !== false;
}

function isLargePlayerBarMode() {
  return extension_settings[extensionName]?.playerBarSize === "large";
}

function updatePlayerBarSizeMenuText() {
  const item = document.getElementById("tts-player-size-toggle");
  if (item) item.textContent = isLargePlayerBarMode() ? "小进度条" : "大进度条";
}

function setPlayerBarSizeMode(size) {
  extension_settings[extensionName].playerBarSize = size === "large" ? "large" : "small";
  saveSettingsDebounced();
  playerBarDragged = false;
  updatePlayerBarSizeMenuText();
  const bar = document.getElementById("tts-player-bar");
  if (bar) applyResponsivePlayerBarLayout(bar);
}

function getSilentAudioUrl() {
  if (!silentAudioUrl) silentAudioUrl = makeSilentWavUrl();
  return silentAudioUrl;
}

function formatTtsTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function updateFloatingPlayerUI() {
  const audio = ttsAudioEl;
  const playBtn = document.getElementById("tts-player-play");
  const timeText = document.getElementById("tts-player-time");
  const fill = document.getElementById("tts-player-progress-fill");
  if (!audio) return;

  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  const percent = duration > 0 ? Math.max(0, Math.min(100, (current / duration) * 100)) : 0;

  if (playBtn) playBtn.textContent = audio.paused ? "▶" : "❚❚";
  if (timeText) timeText.textContent = `${formatTtsTime(current)} / ${formatTtsTime(duration)}`;
  if (fill) fill.style.width = `${percent}%`;
}

function setTtsPlaybackRate(rate) {
  const safeRate = Number(rate) || 1;
  extension_settings[extensionName].ttsPlaybackRate = safeRate;
  saveSettingsDebounced();
  if (ttsAudioEl) ttsAudioEl.playbackRate = safeRate;
  document.querySelectorAll(".tts-speed-item").forEach((item) => {
    item.style.color = Number(item.dataset.rate) === safeRate ? "#ffd54a" : "#fff";
  });
  const speedRange = document.getElementById("tts-player-speed-range");
  const speedValue = document.getElementById("tts-player-speed-value");
  if (speedRange) speedRange.value = String(safeRate);
  if (speedValue) speedValue.textContent = `${safeRate.toFixed(2)}x`;
}

function downloadLastTtsAudio() {
  if (!lastTtsAudioUrl) {
    toastr.info("还没有可下载的语音，先生成或播放一次。", "TTS");
    return;
  }
  const link = document.createElement("a");
  link.href = lastTtsAudioUrl;
  link.download = lastTtsDownloadName;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function openSiliconflowSettingsPanel() {
  const openCandidates = [
    "#extensions_button",
    "#extensions_settings_button",
    "#rm_extensions_block .drawer-toggle",
    ".drawer-icon[data-drawer='extensions']",
    ".drawer-toggle[data-drawer='extensions']",
    "[title='扩展程序']",
    "[title='Extensions']",
  ];
  for (const selector of openCandidates) {
    const button = document.querySelector(selector);
    if (button && button.offsetParent !== null) {
      button.click();
      break;
    }
  }

  const root = $(".siliconflow-extension-settings").first();
  if (root.length === 0) {
    toastr.warning("还没有找到硅基语音设置面板。", "TTS");
    return;
  }
  const reveal = () => {
    const drawer = root.find(".inline-drawer-content").first();
    const icon = root.find(".inline-drawer-icon").first();
    root.show();
    root.parents().each(function () {
      const el = this;
      if (el && el.style && getComputedStyle(el).display === "none") el.style.display = "";
    });
    drawer.data("open", true).show();
    icon.addClass("down");
    root[0].scrollIntoView({ behavior: "smooth", block: "start" });
  };
  reveal();
  setTimeout(reveal, 250);
  setTimeout(reveal, 700);
}

function forceShowPlayerBarElement(bar) {
  if (!bar) return;
  bar.style.setProperty("display", "flex", "important");
  bar.style.setProperty("visibility", "visible", "important");
  bar.style.setProperty("opacity", "1", "important");
  bar.style.setProperty("pointer-events", "auto", "important");
  applyResponsivePlayerBarLayout(bar);
}

function forceHidePlayerBarElement(bar) {
  if (!bar) return;
  bar.style.setProperty("display", "none", "important");
}

function positionPlayerBarNearAnchor(bar, anchorElement) {
  if (!bar || !anchorElement || !document.body.contains(anchorElement)) return false;
  const anchorRect = anchorElement.getBoundingClientRect();
  const barRect = bar.getBoundingClientRect();
  const gap = 8;
  const margin = 8;
  const barWidth = barRect.width || bar.offsetWidth || 180;
  const barHeight = barRect.height || bar.offsetHeight || 36;
  let x = anchorRect.left;
  let y = anchorRect.bottom + gap;

  if (y + barHeight > window.innerHeight - margin) {
    y = anchorRect.top - barHeight - gap;
  }

  x = Math.max(margin, Math.min(x, window.innerWidth - barWidth - margin));
  y = Math.max(margin, Math.min(y, window.innerHeight - barHeight - margin));

  bar.style.left = `${x}px`;
  bar.style.top = `${y}px`;
  bar.style.right = "auto";
  bar.style.bottom = "auto";
  bar.style.transform = "none";
  return true;
}

function applyResponsivePlayerBarLayout(bar) {
  if (!bar) return;

  const isMobileWidth = window.innerWidth <= 720;
  const largeMobile = isMobileWidth && isLargePlayerBarMode();
  const compact = isMobileWidth && !largeMobile;
  const progress = document.getElementById("tts-player-progress");
  const timeText = document.getElementById("tts-player-time");
  const dragLabel = document.getElementById("tts-player-drag-label");
  const versionTag = document.getElementById("tts-player-version");
  const playBtn = document.getElementById("tts-player-play");
  const menuBtn = document.getElementById("tts-player-menu");
  const closeBtn = document.getElementById("tts-player-close");
  if (dragLabel) dragLabel.style.display = compact ? "none" : "inline";
  if (versionTag) versionTag.style.display = isMobileWidth ? "none" : "inline";
  if (!playerBarDragged) {
    bar.style.top = isMobileWidth ? "60%" : "auto";
    bar.style.left = isMobileWidth ? "10px" : "20px";
    bar.style.right = "auto";
    bar.style.bottom = isMobileWidth ? "auto" : "calc(92px + env(safe-area-inset-bottom, 0px))";
    bar.style.transform = isMobileWidth ? "translateY(-50%)" : "none";
    bar.style.width = largeMobile ? "calc(100vw - 20px)" : "auto";
    bar.style.maxWidth = isMobileWidth ? "calc(100vw - 20px)" : "calc(100vw - 40px)";
    bar.style.boxSizing = "border-box";
    bar.style.justifyContent = "flex-start";
    bar.style.gap = compact ? "4px" : "8px";
    bar.style.padding = compact ? "4px 6px" : "6px 10px";
    if (playBtn) {
      playBtn.style.width = compact ? "24px" : "36px";
      playBtn.style.height = compact ? "24px" : "34px";
      playBtn.style.borderRadius = compact ? "12px" : "17px";
      playBtn.style.lineHeight = compact ? "24px" : "34px";
      playBtn.style.fontSize = compact ? "12px" : "16px";
      playBtn.style.cursor = compact ? "move" : "pointer";
      playBtn.title = compact ? "轻点播放/暂停，按住拖动" : "播放/暂停";
    }
    if (progress) {
      progress.style.width = compact ? "auto" : "150px";
      progress.style.maxWidth = compact ? "none" : "30vw";
      progress.style.flex = compact ? "0 1 42px" : (largeMobile ? "1 1 96px" : "1 1 110px");
      progress.style.minWidth = compact ? "0" : (largeMobile ? "76px" : "90px");
      progress.style.height = compact ? "4px" : "6px";
    }
    if (timeText) {
      timeText.style.minWidth = compact ? "42px" : (largeMobile ? "66px" : "76px");
      timeText.style.fontSize = compact ? "10px" : (largeMobile ? "12px" : "13px");
    }
    if (menuBtn) {
      menuBtn.style.padding = compact ? "0 4px" : "0 8px";
      menuBtn.style.fontSize = compact ? "18px" : "22px";
    }
    if (closeBtn) {
      closeBtn.style.padding = compact ? "0 2px" : "0 4px";
      closeBtn.style.fontSize = compact ? "14px" : "16px";
    }
    if (playerBarAnchorElement && positionPlayerBarNearAnchor(bar, playerBarAnchorElement)) {
      return;
    }
    return;
  }

  const rect = bar.getBoundingClientRect();
  let x = rect.left;
  let y = rect.top;
  x = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  y = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
  bar.style.left = `${x}px`;
  bar.style.top = `${y}px`;
  bar.style.right = "auto";
  bar.style.bottom = "auto";
  bar.style.transform = "none";
}

function getTtsAudioEl() {
  if (!ttsAudioEl) {
    // 底部播放条容器
    const bar = document.createElement("div");
    bar.id = "tts-player-bar";
    bar.style.cssText =
      "position:fixed;left:50%;transform:translateX(-50%);bottom:90px;z-index:99999;" +
      "display:none;align-items:center;gap:8px;padding:6px 10px;border-radius:12px;" +
      "background:rgba(0,0,0,0.8);box-shadow:0 2px 10px rgba(0,0,0,0.5);max-width:92vw;" +
      "box-sizing:border-box;";

    const label = document.createElement("span");
    label.id = "tts-player-drag-label";
    label.textContent = "🔊";
    label.title = "按住拖动";
    label.style.cssText = "font-size:16px;line-height:1;flex:0 0 auto;cursor:move;touch-action:none;padding:0 2px;";

    // 按住 🔊 可把整条播放条拖到屏幕任意位置（悬浮，不挡视线）
    let drag = null;
    let playButtonWasDragged = false;
    const startPlayerBarDrag = (e, target, fromPlayButton = false) => {
      const rect = bar.getBoundingClientRect();
      drag = {
        dx: e.clientX - rect.left,
        dy: e.clientY - rect.top,
        startX: e.clientX,
        startY: e.clientY,
        fromPlayButton,
        moved: false,
        wasDraggedBefore: playerBarDragged,
      };
      playerBarDragged = true;
      bar.style.transform = "none";
      bar.style.left = rect.left + "px";
      bar.style.top = rect.top + "px";
      bar.style.bottom = "auto";
      bar.style.right = "auto";
      bar.style.width = bar.offsetWidth + "px";
      try { target.setPointerCapture(e.pointerId); } catch (err) {}
      if (!fromPlayButton) e.preventDefault();
    };
    const movePlayerBarDrag = (e) => {
      if (!drag) return;
      const movedEnough = Math.abs(e.clientX - drag.startX) > 4 || Math.abs(e.clientY - drag.startY) > 4;
      if (movedEnough) {
        drag.moved = true;
        playerBarAnchorElement = null;
        if (drag.fromPlayButton) playButtonWasDragged = true;
        e.preventDefault();
      }
      let x = e.clientX - drag.dx;
      let y = e.clientY - drag.dy;
      x = Math.max(0, Math.min(x, window.innerWidth - bar.offsetWidth));
      y = Math.max(0, Math.min(y, window.innerHeight - bar.offsetHeight));
      bar.style.left = x + "px";
      bar.style.top = y + "px";
    };
    const endDrag = () => {
      if (drag && drag.fromPlayButton && !drag.moved && !drag.wasDraggedBefore) {
        playerBarDragged = false;
        applyResponsivePlayerBarLayout(bar);
      }
      drag = null;
    };
    label.addEventListener("pointerdown", (e) => startPlayerBarDrag(e, label));
    label.addEventListener("pointermove", movePlayerBarDrag);
    label.addEventListener("pointerup", endDrag);
    label.addEventListener("pointercancel", endDrag);

    ttsAudioEl = document.createElement("audio");
    ttsAudioEl.id = "tts-native-player";
    ttsAudioEl.removeAttribute("controls");
    ttsAudioEl.setAttribute("playsinline", "");
    ttsAudioEl.setAttribute("webkit-playsinline", "");
    ttsAudioEl.preload = "metadata";
    ttsAudioEl.style.cssText = "display:none;width:0;height:0;";
    ttsAudioEl.src = getSilentAudioUrl();
    ttsAudioEl.playbackRate = extension_settings[extensionName].ttsPlaybackRate || 1;

    const playBtn = document.createElement("button");
    playBtn.id = "tts-player-play";
    playBtn.type = "button";
    playBtn.textContent = "▶";
    playBtn.title = "播放/暂停";
    playBtn.style.cssText =
      "width:36px;height:34px;border:0;border-radius:17px;background:#fff;color:#000;" +
      "font-size:16px;line-height:34px;padding:0;cursor:pointer;flex:0 0 auto;";
    playBtn.addEventListener("pointerdown", (e) => {
      if (window.innerWidth <= 720) startPlayerBarDrag(e, playBtn, true);
    });
    playBtn.addEventListener("pointermove", movePlayerBarDrag);
    playBtn.addEventListener("pointerup", endDrag);
    playBtn.addEventListener("pointercancel", endDrag);
    playBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (playButtonWasDragged) {
        playButtonWasDragged = false;
        return;
      }
      const audio = getTtsAudioEl();
      if (audio.paused) {
        try {
          await audio.play();
        } catch (err) {
          toastr.info("还没有可播放的语音，先点消息旁边的播放三角形生成一次。", "TTS");
        }
      } else {
        audio.pause();
      }
      updateFloatingPlayerUI();
    });

    const timeText = document.createElement("span");
    timeText.id = "tts-player-time";
    timeText.textContent = "0:00 / --:--";
    timeText.style.cssText = "color:#fff;font-size:13px;white-space:nowrap;min-width:76px;text-align:center;flex:0 0 auto;";

    const progress = document.createElement("div");
    progress.id = "tts-player-progress";
    progress.title = "点击跳转进度";
    progress.style.cssText =
      "width:150px;max-width:30vw;height:6px;border-radius:999px;background:rgba(255,255,255,0.35);" +
      "overflow:hidden;cursor:pointer;flex:1 1 110px;";
    const progressFill = document.createElement("div");
    progressFill.id = "tts-player-progress-fill";
    progressFill.style.cssText = "height:100%;width:0%;background:#fff;border-radius:999px;";
    progress.appendChild(progressFill);
    progress.addEventListener("click", (e) => {
      const audio = getTtsAudioEl();
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
      const rect = progress.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      audio.currentTime = ratio * audio.duration;
      updateFloatingPlayerUI();
    });

    ["loadedmetadata", "durationchange", "timeupdate", "play", "playing", "pause", "ended", "emptied"].forEach((eventName) => {
      ttsAudioEl.addEventListener(eventName, updateFloatingPlayerUI);
    });

    // 我自己的「⋮」菜单按钮，点开里面有「TTS日志」
    const menuBtn = document.createElement("span");
    menuBtn.id = "tts-player-menu";
    menuBtn.textContent = "⋮";
    menuBtn.title = "更多";
    menuBtn.style.cssText = "color:#fff;cursor:pointer;padding:0 8px;font-size:22px;font-weight:bold;line-height:1;flex:0 0 auto;";

    const versionTag = document.createElement("span");
    versionTag.id = "tts-player-version";
    versionTag.textContent = "v1.6.4";
    versionTag.title = "悬浮进度条版本";
    versionTag.style.cssText = "color:rgba(255,255,255,0.45);font-size:10px;line-height:1;flex:0 0 auto;";

    const menu = document.createElement("div");
    menu.id = "tts-bar-menu";
    menu.style.cssText = "position:absolute;bottom:110%;right:6px;background:#222;border:1px solid #555;border-radius:8px;padding:6px 0;display:none;min-width:150px;box-shadow:0 2px 12px rgba(0,0,0,0.7);z-index:100001;";
    menu.addEventListener("click", (e) => e.stopPropagation());
    const makeMenuItem = (text, onClick, className = "") => {
      const item = document.createElement("div");
      item.textContent = text;
      if (className) item.className = className;
      item.style.cssText = "color:#fff;padding:9px 14px;cursor:pointer;font-size:14px;white-space:nowrap;";
      item.addEventListener("mouseenter", () => { item.style.background = "rgba(255,255,255,0.12)"; });
      item.addEventListener("mouseleave", () => { item.style.background = "transparent"; });
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
      });
      return item;
    };
    const logItem = document.createElement("div");
    logItem.textContent = "TTS日志";
    logItem.style.cssText = "color:#00ff7f;padding:10px 16px;cursor:pointer;font-size:14px;white-space:nowrap;";
    logItem.addEventListener("click", () => {
      ttsLog("（打开日志）"); // 确保面板已创建
      const panel = document.getElementById("tts-log-panel");
      if (panel) {
        const hidden = (panel.style.display === "none" || !panel.style.display);
        if (hidden) {
          const rect = bar.getBoundingClientRect();
          panel.style.display = "block";
          const panelRect = panel.getBoundingClientRect();
          const gap = 8;
          const left = Math.max(gap, Math.min(rect.left, window.innerWidth - panelRect.width - gap));
          let top = rect.top - panelRect.height - gap;
          if (top < gap) top = Math.min(rect.bottom + gap, window.innerHeight - panelRect.height - gap);
          panel.style.left = `${left}px`;
          panel.style.top = `${Math.max(gap, top)}px`;
          panel.style.bottom = "auto";
          panel.style.zIndex = "100500";
        }
        panel.style.display = hidden ? "block" : "none";
      }
      menu.style.display = "none";
    });
    menu.appendChild(logItem);

    const downloadItem = makeMenuItem("下载音频", () => {
      downloadLastTtsAudio();
      menu.style.display = "none";
    });
    menu.appendChild(downloadItem);

    const resetPositionItem = makeMenuItem("重置位置", () => {
      playerBarDragged = false;
      applyResponsivePlayerBarLayout(bar);
      updatePlayerBarSizeMenuText();
      menu.style.display = "none";
    });
    menu.appendChild(resetPositionItem);

    const sizeToggleItem = makeMenuItem(isLargePlayerBarMode() ? "小进度条" : "大进度条", () => {
      setPlayerBarSizeMode(isLargePlayerBarMode() ? "small" : "large");
      menu.style.display = "none";
    });
    sizeToggleItem.id = "tts-player-size-toggle";
    menu.appendChild(sizeToggleItem);

    const settingsItem = makeMenuItem("设置", () => {
      openSiliconflowSettingsPanel();
      menu.style.display = "none";
    });
    menu.appendChild(settingsItem);

    const speedTitle = document.createElement("div");
    speedTitle.style.cssText = "color:#aaa;padding:8px 14px 4px;font-size:12px;white-space:nowrap;border-top:1px solid rgba(255,255,255,0.14);margin-top:4px;";
    speedTitle.innerHTML = '播放速度 <span id="tts-player-speed-value" style="color:#fff;">1.00x</span>';
    menu.appendChild(speedTitle);

    const speedControl = document.createElement("div");
    speedControl.style.cssText = "padding:4px 14px 12px;";
    const speedRange = document.createElement("input");
    speedRange.id = "tts-player-speed-range";
    speedRange.type = "range";
    speedRange.min = "0.5";
    speedRange.max = "2";
    speedRange.step = "0.01";
    speedRange.value = String(extension_settings[extensionName].ttsPlaybackRate || 1);
    speedRange.style.cssText = "width:160px;margin:0;";
    speedRange.addEventListener("input", () => setTtsPlaybackRate(parseFloat(speedRange.value)));
    speedControl.appendChild(speedRange);
    menu.appendChild(speedControl);
    setTtsPlaybackRate(extension_settings[extensionName].ttsPlaybackRate || 1);

    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.style.display = (menu.style.display === "none") ? "block" : "none";
    });
    // 点别处收起菜单
    document.addEventListener("click", (e) => {
      if (menu.style.display === "block" && e.target !== menuBtn && !menu.contains(e.target)) {
        menu.style.display = "none";
      }
    });
    window.addEventListener("resize", () => applyResponsivePlayerBarLayout(bar));
    window.addEventListener("orientationchange", () => setTimeout(() => applyResponsivePlayerBarLayout(bar), 250));

    const closeBtn = document.createElement("span");
    closeBtn.id = "tts-player-close";
    closeBtn.textContent = "✕";
    closeBtn.style.cssText = "color:#fff;cursor:pointer;padding:0 4px;font-size:16px;flex:0 0 auto;";
    closeBtn.addEventListener("click", () => {
      try { ttsAudioEl.pause(); } catch (e) {}
      resetPlayState();
      setPersistentPlayerBarEnabled(false);
    });

    bar.appendChild(label);
    bar.appendChild(playBtn);
    bar.appendChild(timeText);
    bar.appendChild(progress);
    bar.appendChild(ttsAudioEl);
    bar.appendChild(versionTag);
    bar.appendChild(menuBtn);
    bar.appendChild(menu);
    bar.appendChild(closeBtn);
    document.body.appendChild(bar);
    updateFloatingPlayerUI();
  }
  return ttsAudioEl;
}

let barClosedByUser = false;
function showPlayerBar() {
  const el = getTtsAudioEl();
  const bar = document.getElementById("tts-player-bar");
  if (bar) {
    barClosedByUser = false; // 主动调用显示时，取消“已关闭”状态
    forceShowPlayerBarElement(bar);
    updateFloatingPlayerUI();
  }
  return el;
}

function ensurePersistentPlayerBar() {
  if (!shouldKeepPlayerBarVisible()) return;
  const el = getTtsAudioEl();
  if (el && !el.getAttribute("src") && !el.src) {
    el.src = getSilentAudioUrl();
  }
  const bar = document.getElementById("tts-player-bar");
  if (bar) {
    barClosedByUser = false;
    forceShowPlayerBarElement(bar);
    updateFloatingPlayerUI();
  }
}

// 在设置面板里加「语音进度条 开/关」滑动开关
function setBarToggleUI(on) {
  const track = document.getElementById("tts-bar-toggle");
  const knob = document.getElementById("tts-bar-knob");
  const state = document.getElementById("tts-bar-toggle-state");
  if (track) {
    track.style.background = on ? "#3ba55d" : "#777";
    if (knob) knob.style.left = on ? "22px" : "2px";
    if (state) state.textContent = on ? "开" : "关";
  }
  updateInlineBarControlsUI(on);
}

function updateInlineBarControlsUI(on = shouldKeepPlayerBarVisible()) {
  $(".tts-bar-toggle-inline-btn")
    .text(on ? "-" : "+")
    .attr("title", on ? "隐藏语音进度条" : "显示语音进度条")
    .toggleClass("tts-inline-active", !!on);
}

function setPersistentPlayerBarEnabled(on, anchorElement = null) {
  extension_settings[extensionName].barPersistent = !!on;
  saveSettingsDebounced();
  setBarToggleUI(!!on);

  const bar = document.getElementById("tts-player-bar");
  if (on) {
    barClosedByUser = false;
    playerBarDragged = false;
    playerBarAnchorElement = anchorElement || playerBarAnchorElement;
    ensurePersistentPlayerBar();
  } else {
    barClosedByUser = true;
    playerBarAnchorElement = null;
    forceHidePlayerBarElement(bar);
  }
}

function createBarToggle() {
  if (document.getElementById("tts-bar-toggle")) return;
  const on = shouldKeepPlayerBarVisible(); // 默认开
  const section = $(
    '<div class="sub-section" style="flex-basis:100%;width:100%;margin-top:10px;">' +
    '<div style="display:flex;align-items:center;gap:12px;">' +
    '<b>🔊 语音进度条</b>' +
    '<span id="tts-bar-toggle" style="position:relative;display:inline-block;width:44px;height:24px;border-radius:12px;background:#777;cursor:pointer;transition:background .2s;flex:0 0 auto;">' +
    '<span id="tts-bar-knob" style="position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;transition:left .2s;box-shadow:0 1px 3px rgba(0,0,0,0.4);"></span>' +
    '</span>' +
    '<span id="tts-bar-toggle-state" style="opacity:0.85;"></span>' +
    '</div>' +
    '<div style="font-size:12px;opacity:0.7;margin-top:4px;">开：进度条常驻显示；关：平时隐藏（朗读时仍会自动弹出，方便点播放）。</div>' +
    '</div>'
  );
  // 放在「文本截取设置 / TTS测试」这一块前面，醒目
  const flexC = $(".siliconflow-extension-settings .inline-drawer-content .flex-container").first();
  if (flexC.length > 0) flexC.prepend(section);
  else $("#extensions_settings").append(section);

  setBarToggleUI(on);
  let lastToggleAt = 0;
  $("#tts-bar-toggle").on("pointerup touchend click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    if (now - lastToggleAt < 350) return;
    lastToggleAt = now;
    setPersistentPlayerBarEnabled(!shouldKeepPlayerBarVisible());
  });
}

// 生成一段极短的静音 WAV，用于在用户手势内“解锁”音频元素
function makeSilentWavUrl() {
  const sampleRate = 8000, numSamples = 400; // 0.05s
  const buffer = new ArrayBuffer(44 + numSamples);
  const view = new DataView(buffer);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF"); view.setUint32(4, 36 + numSamples, true); writeStr(8, "WAVE");
  writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  writeStr(36, "data"); view.setUint32(40, numSamples, true);
  for (let i = 0; i < numSamples; i++) view.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([view], { type: "audio/wav" }));
}

// 用户手势内调用一次即可解锁移动端音频（播放条保持隐藏）
function primeAudioOnce() {
  if (audioPrimed) return;
  const el = getTtsAudioEl();
  try {
    el.src = getSilentAudioUrl();
    const p = el.play();
    if (p && p.then) {
      p.then(() => { audioPrimed = true; }).catch(() => {});
    } else {
      audioPrimed = true;
    }
  } catch (e) {}
}

// 实际播放一个音频URL：头像旁 ▶ 只负责播放，不主动弹出进度条；需要进度条时点消息旁的 +。
function playAudioUrl(audioUrl, buttonElement) {
  ttsLog("⑥ 尝试播放音频");
  const audio = getTtsAudioEl();
  try { audio.pause(); } catch (e) {}

  lastTtsAudioUrl = audioUrl;
  lastTtsDownloadName = `tts_output.${extension_settings[extensionName].responseFormat || "mp3"}`;
  audio.volume = 1.0;
  audio.playbackRate = extension_settings[extensionName].ttsPlaybackRate || 1;
  audioState.currentAudio = audio;
  audioState.isPlaying = true;

  const btn = buttonElement && buttonElement.length > 0 ? buttonElement : audioState.playingButton;
  if (btn && btn.length > 0) {
    audioState.playingButton = btn;
    setButtonState(btn, "loading"); // 出声前保持黄
  }

  audio.onplaying = () => {
    if (audioState.playingButton) setButtonState(audioState.playingButton, "playing"); // 出声转绿
  };
  audio.onended = () => {
    console.log('音频播放完成');
    resetPlayState();
  };
  audio.onerror = () => {
    ttsLog("❌ 音频元素报错（解码失败？）");
    resetPlayState();
    toastr.error('音频解码/播放失败，可能返回的不是有效音频。', 'TTS');
  };

  audio.src = audioUrl;
  audio.load();
  updateFloatingPlayerUI();
  audio.play().then(() => {
    ttsLog("✅ 自动播放成功，应该有声音了");
    if (audioState.playingButton) setButtonState(audioState.playingButton, "playing");
  }).catch(err => {
    ttsLog("⚠️ 自动播放被拦，请点消息旁的 + 打开进度条，再点进度条里的 ▶。原因：" + (err && err.message ? err.message : err));
    if (audioState.playingButton) setButtonState(audioState.playingButton, "playing");
    toastr.info('如未出声，点消息旁的 + 打开进度条，再点进度条里的 ▶', 'TTS', { timeOut: 5000 });
  });
}

// ============ 喇叭按钮辅助函数（新增） ============

// 把所有按钮恢复到待机，并清空播放状态
function resetPlayState() {
  audioState.isPlaying = false;
  audioState.currentAudio = null;
  $(".tts-manual-play-btn").removeClass("tts-loading tts-playing");
  audioState.playingButton = null;
}

// 三种外观：idle 待机 / loading 加载中 / playing 播放中
// 注入一次性的高优先级样式（带 !important，确保一定可见）
function injectTTSStyle() {
  if (document.getElementById("tts-btn-style")) return;
  const style = document.createElement("style");
  style.id = "tts-btn-style";
  style.textContent = `
    @keyframes ttsGlowPulse {
      0%, 100% { transform: scale(1); }
      50%      { transform: scale(1.3); }
    }
    .tts-manual-play-btn {
      display: inline-flex !important;
      align-items: center;
      justify-content: center;
      min-width: 1.35em;
      height: 1.35em;
      margin: 0;
      font-size: 1.05em;
      font-weight: bold;
      line-height: 1;
      cursor: pointer;
      vertical-align: middle;
      user-select: none;
      color: #9aa0a6;
      position: relative;
      z-index: 60;
      pointer-events: auto !important;
      padding: 0 2px;
      transition: color 0.15s, text-shadow 0.15s, transform 0.15s;
    }
    .tts-voice-control-group {
      display: inline-flex !important;
      align-items: center;
      gap: 2px;
      margin-left: 5px;
      vertical-align: middle;
      position: relative;
      z-index: 60;
      pointer-events: auto !important;
    }
    .tts-bar-inline-btn {
      display: inline-flex !important;
      align-items: center;
      justify-content: center;
      min-width: 1.15em;
      height: 1.15em;
      border-radius: 4px;
      padding: 0 2px;
      color: #9aa0a6;
      font-size: 0.95em;
      font-weight: 800;
      line-height: 1;
      cursor: pointer;
      user-select: none;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.18);
      transition: color 0.15s, background 0.15s, border-color 0.15s;
    }
    .tts-bar-inline-btn:hover {
      color: #fff;
      background: rgba(255,255,255,0.16);
    }
    .tts-bar-inline-btn.tts-inline-active {
      color: #00ffae !important;
      border-color: rgba(0,255,174,0.75);
      background: rgba(0,255,174,0.16);
      text-shadow: 0 0 6px rgba(0,255,174,0.75);
    }
    .tts-manual-play-btn:hover { color: #e0e0e0; }
    /* 生成中：荧光黄，符号本身发光 + 跳动 */
    .tts-manual-play-btn.tts-loading {
      color: #f6ff00 !important;
      text-shadow: 0 0 6px #f6ff00, 0 0 14px #f6ff00, 0 0 2px #ffffff;
      animation: ttsGlowPulse 0.8s infinite;
    }
    /* 播放中：荧光青绿，符号发光 + 放大 */
    .tts-manual-play-btn.tts-playing {
      color: #00ffae !important;
      text-shadow: 0 0 6px #00ffae, 0 0 16px #00ffae, 0 0 2px #ffffff;
      transform: scale(1.2);
    }
  `;
  document.head.appendChild(style);
}

// 切换状态：idle 待机 / loading 生成中(黄,跳动) / playing 播放中(蓝)。只换颜色，emoji 始终是 🔊
function setButtonState(button, state) {
  if (!button || button.length === 0) return;
  button.removeClass("tts-loading tts-playing");
  if (state === "loading") {
    button.addClass("tts-loading");
  } else if (state === "playing") {
    button.addClass("tts-playing");
  }
}

// 给每条消息注入“朗读/停止”按钮（点击逻辑用事件委托，见 bindPlayButtonDelegation）
function injectPlayButton() {
  $(".mes").each(function () {
    const messageElement = $(this);
    if (messageElement.find(".tts-voice-control-group").length > 0) return;
    messageElement.find(".tts-manual-play-btn").not(".tts-voice-control-group .tts-manual-play-btn").remove();

    const controls = $(
      '<span class="tts-voice-control-group" title="语音控制">' +
      '<span class="tts-manual-play-btn" title="朗读 / 停止" role="button">▶</span>' +
      '<span class="tts-bar-inline-btn tts-bar-toggle-inline-btn" title="显示语音进度条" role="button">+</span>' +
      '</span>'
    );

    // 放到角色名字「右边」：避开左侧的翻页箭头，避免被它盖住点不到
    const nameText = messageElement.find(".name_text").first();
    if (nameText.length > 0) {
      nameText.after(controls);
    } else {
      let target = messageElement.find(".ch_name").first();
      if (target.length === 0) target = messageElement.find(".mes_block").first();
      if (target.length === 0) target = messageElement;
      target.append(controls);
    }
    updateInlineBarControlsUI();
  });
}

// 事件委托：只绑定一次，消息怎么重绘都能接住点击
let playDelegationBound = false;
function bindPlayButtonDelegation() {
  if (playDelegationBound) return;
  playDelegationBound = true;

  $(document).on("click", ".tts-bar-toggle-inline-btn", function (e) {
    e.preventDefault();
    e.stopPropagation();
    const nextOn = !shouldKeepPlayerBarVisible();
    setPersistentPlayerBarEnabled(nextOn, nextOn ? this : null);
  });

  $(document).on("click", ".tts-manual-play-btn", async function (e) {
    e.preventDefault();
    e.stopPropagation();
    const playBtn = $(this);
    const messageElement = playBtn.closest(".mes");
    try {
      ttsLog("👆 点击 ▶");
      primeAudioOnce();

      // 再点正在播放的按钮 = 停止
      if (audioState.playingButton && audioState.playingButton[0] === playBtn[0]) {
        ttsLog("⏹ 再次点击 → 停止");
        if (audioState.currentAudio) audioState.currentAudio.pause();
        resetPlayState();
        return;
      }

      let messageText = getMessageSourceText(messageElement);
      if (!messageText) {
        ttsLog("❌ 这条消息读不到文字（空/折叠块）");
        toastr.warning("这条消息没有可朗读的文字，换一条角色回复试试。", "TTS");
        return;
      }
      ttsLog("原文长度 " + messageText.length);

      let textToRead = prepareTextForTts(messageText);
      if (!textToRead) {
        ttsLog("⚠ 额外提取规则过滤后没有可朗读文字");
        toastr.warning("这条消息按当前标签规则没有可朗读内容。", "TTS");
        return;
      }
      ttsLog("✂ 最终朗读文本 " + textToRead.length + " 字");

      const speakerName = getMessageSpeakerName(messageElement);
      const voiceForSpeaker = getVoiceForSpeaker(speakerName);
      if (speakerName) ttsLog("🎭 说话人：" + speakerName + "，音色=" + voiceForSpeaker);
      await generateTTS(textToRead, playBtn, voiceForSpeaker);
    } catch (err) {
      ttsLog("❌ 点击处理异常：" + (err && err.message ? err.message : err));
      resetPlayState();
    }
  });
}

// 按设置里的开始/结束符号提取文本；提取不到返回空串
// 把各种弯引号、全角引号统一成直引号，这样无论标记设直/弯都能匹配
function normalizeQuotes(s) {
  if (!s) return s;
  return s
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u3003\uFF02]/g, '"')   // “ ” „ ‟ ″ 〃 ＂ → "
    .replace(/[\u2018\u2019\u201A\u201B\u2032\uFF07]/g, "'");        // ‘ ’ ‚ ‛ ′ ＇ → '
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findTagBlocks(message, pairs) {
  const blocks = [];
  getEnabledTagPairs(pairs).forEach(pair => {
    const startMatch = pair.start.match(/^<\s*([^\s>/]+)[^>]*>$/);
    const endMatch = pair.end.match(/^<\s*\/\s*([^\s>]+)\s*>$/);
    const startPattern = startMatch ? `<\\s*${escapeRegex(startMatch[1])}(?:\\s[^>]*)?>` : escapeRegex(pair.start);
    const endPattern = endMatch ? `<\\s*\\/\\s*${escapeRegex(endMatch[1])}\\s*>` : escapeRegex(pair.end);
    const re = new RegExp(startPattern + "([\\s\\S]*?)" + endPattern, "gi");
    let match;
    while ((match = re.exec(message)) !== null) {
      blocks.push({
        start: match.index,
        end: match.index + match[0].length,
        text: match[1].trim(),
      });
    }
  });
  return blocks.sort((a, b) => a.start - b.start);
}

function removeRanges(message, ranges) {
  if (!ranges.length) return message;
  let result = "";
  let cursor = 0;
  ranges.sort((a, b) => a.start - b.start).forEach(range => {
    if (range.start < cursor) return;
    result += message.slice(cursor, range.start);
    cursor = range.end;
  });
  result += message.slice(cursor);
  return result;
}

function textOutsideRanges(message, ranges) {
  return removeRanges(message, ranges)
    .replace(/<[^>]+>/g, " ")
    .trim();
}

function stripAllTagBlocks(message) {
  return String(message || "")
    .replace(/<([A-Za-z][\w:-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .trim();
}

function getAllConfiguredTagBlocks(message) {
  const allPairs = [
    ...(extension_settings[extensionName].skipTagPairs || []),
    ...(extension_settings[extensionName].readTagPairs || []),
  ].filter(pair => pair?.start && pair?.end);
  return findTagBlocks(message, allPairs);
}

function getConfiguredReadTagBlocks(message) {
  const readPairs = (extension_settings[extensionName].readTagPairs || [])
    .filter(pair => pair?.start && pair?.end);
  return findTagBlocks(message, readPairs);
}

function normalizeTtsWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(text) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = String(text || "");
  return textarea.value;
}

function getMessageSourceText(messageElement) {
  const mainText = messageElement.find(".mes_text").first();
  if (extension_settings[extensionName].extraTextRulesEnabled === true && mainText.length > 0) {
    const html = mainText.html() || "";
    return decodeHtmlEntities(html.replace(/<br\s*\/?>/gi, "\n")).trim();
  }
  let text = mainText.text().trim();
  if (!text) {
    text = messageElement.find(".mes_reasoning_content, .mes_reasoning, .mes_block").text().trim();
  }
  return text;
}

function prepareTextForTts(message) {
  if (extension_settings[extensionName].extraTextRulesEnabled === true) {
    const skipPairs = getEnabledTagPairs(extension_settings[extensionName].skipTagPairs);
    const readPairs = getEnabledTagPairs(extension_settings[extensionName].readTagPairs);
    const includeUntagged = extension_settings[extensionName].readUntaggedWithRequired === true;
    let working = String(message || "");

    const skipBlocks = findTagBlocks(working, skipPairs);
    if (skipBlocks.length > 0) {
      working = removeRanges(working, skipBlocks);
    }

    const parts = [];

    let readBlocks = [];
    if (readPairs.length > 0) {
      readBlocks = findTagBlocks(working, readPairs);
      for (const block of readBlocks) {
        const marked = extractMarkedText(block.text);
        if (marked) parts.push(marked);
      }
    }

    if (includeUntagged && readPairs.length > 0) {
      const outsideText = textOutsideRanges(working, readBlocks);
      const outsideMarked = extractMarkedText(outsideText);
      if (outsideMarked) parts.push(outsideMarked);
    }

    if (parts.length > 0) {
      return normalizeTtsWhitespace(parts.join("，"));
    }

    if (readPairs.length === 0) {
      const configuredReadBlocks = getConfiguredReadTagBlocks(working);
      const ordinaryText = includeUntagged ? removeRanges(working, configuredReadBlocks) : working;
      const markedText = extractMarkedText(ordinaryText);
      return normalizeTtsWhitespace(markedText || ordinaryText);
    }

    return "";
  }

  const fullText = normalizeTtsWhitespace(message);
  if (!fullText) return "";
  const markedText = extractMarkedText(fullText);
  return normalizeTtsWhitespace(markedText || fullText);
}

function parseSymbolPairs(startRaw, endRaw) {
  const starts = normalizeQuotes(startRaw).split(/\s+/).filter(Boolean);
  const ends = normalizeQuotes(endRaw).split(/\s+/).filter(Boolean);
  const pairCount = Math.min(starts.length, ends.length);
  if (pairCount === 0) return [];
  return Array.from({ length: pairCount }, (_, index) => ({
    start: starts[index],
    end: ends[index],
    key: `${starts[index]}→${ends[index]}`,
  }));
}

function getSymbolConflictKeys(insidePairs, outsidePairs) {
  const outsideKeys = new Set(outsidePairs.map(pair => pair.key));
  return new Set(insidePairs.filter(pair => outsideKeys.has(pair.key)).map(pair => pair.key));
}

function getCurrentSymbolPairs() {
  const insidePairs = parseSymbolPairs($("#image_text_start").val() || "", $("#image_text_end").val() || "");
  const outsidePairs = parseSymbolPairs($("#tts_symbol_outside_start").val() || "", $("#tts_symbol_outside_end").val() || "");
  return { insidePairs, outsidePairs, conflictKeys: getSymbolConflictKeys(insidePairs, outsidePairs) };
}

function updateSymbolConflictUI() {
  const readInside = $("#tts_read_symbol_inside").prop("checked") === true;
  const readOutside = $("#tts_read_symbol_outside").prop("checked") === true;
  const conflictCount = readInside && readOutside ? getCurrentSymbolPairs().conflictKeys.size : 0;
  const hasConflict = conflictCount > 0;
  $("#image_text_start, #image_text_end, #tts_symbol_outside_start, #tts_symbol_outside_end")
    .toggleClass("sf-symbol-conflict", hasConflict);
  $("#tts_symbol_conflict_hint").toggle(hasConflict);
}

function collectSymbolMatches(message, pairs) {
  if (!pairs.length) return [];

  // 引号通用化：消息和符号都规整一遍，直/弯引号互通
  message = normalizeQuotes(message);

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const markerPattern = (symbol) => {
    if (symbol === "（" || symbol === "(") return "[（(]";
    if (symbol === "）" || symbol === ")") return "[）)]";
    return esc(symbol);
  };
  const found = []; // {start, pos, end, text}

  for (const pair of pairs) {
    const s = pair.start, e = pair.end;
    const quoteLike = (s === '"' || e === '"' || s === "'" || e === "'");
    if (quoteLike || s === e) {
      // 起止相同（如引号）：用配对算法
      let inside = false, cur = "", startPos = -1;
      for (let i = 0; i < message.length; i++) {
        const ch = message[i];
        const isMarker = quoteLike ? (ch === s || ch === e) : ch === s;
        if (isMarker) {
          if (!inside) { inside = true; cur = ""; startPos = i; }
          else {
            if (cur.trim()) found.push({ start: startPos, pos: startPos, end: i + ch.length, text: cur.trim() });
            inside = false;
            cur = "";
          }
        } else if (inside) { cur += ch; }
      }
    } else {
      // 起止不同（如 【】（））：用正则
      const re = new RegExp(markerPattern(s) + "([\\s\\S]*?)" + markerPattern(e), "g");
      let m;
      while ((m = re.exec(message)) !== null) {
        if (m[1].trim()) found.push({ start: m.index, pos: m.index, end: m.index + m[0].length, text: m[1].trim() });
      }
    }
  }

  return found;
}

function extractTextInsideSymbols(message, pairs) {
  const found = collectSymbolMatches(message, pairs);
  if (found.length === 0) return "";
  // 按在消息里出现的先后顺序合并，读起来顺
  found.sort((a, b) => a.pos - b.pos);
  return found.map(f => f.text).join("，");
}

function extractTextOutsideSymbols(message, pairs) {
  const normalizedMessage = normalizeQuotes(message);
  const found = collectSymbolMatches(normalizedMessage, pairs)
    .filter(item => Number.isFinite(item.start) && Number.isFinite(item.end));
  if (found.length === 0) return "";
  ttsLog("✂ 不读此符内：已剔除 " + found.length + " 段");
  return normalizeTtsWhitespace(removeRanges(normalizedMessage, found)) || " ";
}

function extractMarkedText(message) {
  const readInside = $("#tts_read_symbol_inside").length
    ? $("#tts_read_symbol_inside").prop("checked") === true
    : extension_settings[extensionName].symbolReadInside !== false;
  const readOutside = $("#tts_read_symbol_outside").length
    ? $("#tts_read_symbol_outside").prop("checked") === true
    : extension_settings[extensionName].symbolReadOutside === true;

  const { insidePairs, outsidePairs, conflictKeys } = getCurrentSymbolPairs();
  const usableInsidePairs = readInside ? insidePairs.filter(pair => !conflictKeys.has(pair.key)) : [];
  const usableOutsidePairs = readOutside ? outsidePairs.filter(pair => !conflictKeys.has(pair.key)) : [];
  if (readInside && readOutside && conflictKeys.size > 0) {
    ttsLog("⚠ 符号打架：" + Array.from(conflictKeys).join("、") + "，打架的符号已跳过");
    console.warn("符号打架：", Array.from(conflictKeys));
  }

  let working = String(message || "");
  if (usableOutsidePairs.length > 0) {
    const outsideText = extractTextOutsideSymbols(working, usableOutsidePairs);
    if (outsideText) {
      working = outsideText;
    } else {
      ttsLog("⚠ 不读此符内：没有匹配到可排除的符号");
    }
  }

  if (usableInsidePairs.length > 0) {
    const insideText = extractTextInsideSymbols(working, usableInsidePairs);
    if (insideText) return insideText;
    return working !== String(message || "") ? working : "";
  }

  return working !== String(message || "") ? working : "";
}

// 监听消息事件，自动提取文本并生成语音
function setupMessageListener() {
  console.log('设置消息监听器');
  console.log('事件类型:', event_types);
  console.log('eventSource 对象:', eventSource);
  
  // 测试事件是否正常触发
  try {
    // 测试监听所有消息事件
    console.log('尝试监听所有消息相关事件...');
    
    // 监听消息添加事件
    if (event_types.MESSAGE_SENT) {
      eventSource.on(event_types.MESSAGE_SENT, () => {
        console.log('检测到MESSAGE_SENT事件');
      });
    }
    
    // 监听消息接收事件
    if (event_types.MESSAGE_RECEIVED) {
      eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        console.log('检测到MESSAGE_RECEIVED事件');
      });
    }
    
    // 监听聊天更新事件  
    if (event_types.CHAT_CHANGED) {
      eventSource.on(event_types.CHAT_CHANGED, () => {
        console.log('检测到CHAT_CHANGED事件');
      });
    }
  } catch (error) {
    console.error('设置测试监听器出错:', error);
  }
  
  // 监听SillyTavern的消息事件
  eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async (messageId) => {
    console.log('角色消息渲染:', messageId);
    
    // 防止重复处理同一条消息
    if (audioState.lastProcessedMessageId === messageId) {
      console.log('消息已处理，跳过:', messageId);
      return;
    }
    
    console.log('新消息，准备处理:', messageId);
    
    // 检查是否开启自动朗读
    const autoPlay = $("#auto_play_audio").prop("checked");
    if (!autoPlay) {
      console.log('自动朗读未开启');
      return;
    }
    
    // 清除之前的延时器
    if (audioState.processingTimeout) {
      clearTimeout(audioState.processingTimeout);
    }
    
    // 使用防抖处理，等待消息完全渲染
    audioState.processingTimeout = setTimeout(() => {
      console.log('延时处理开始:', messageId);
      // 再次检查是否已处理
      if (audioState.lastProcessedMessageId === messageId) {
        console.log('消息在延迟期间已被处理，跳过');
        return;
      }
      
      // 标记为已处理
      audioState.lastProcessedMessageId = messageId;
      console.log('处理消息:', messageId);
      const messageElement = $(`.mes[mesid="${messageId}"]`);
      console.log('查找消息元素:', messageElement.length > 0 ? '找到' : '未找到');
      
      const message = getMessageSourceText(messageElement);
      console.log('消息内容长度:', message ? message.length : 0);
      
      if (!message) {
        console.log('消息内容为空');
        return;
      }

      const textToRead = prepareTextForTts(message);
      if (!textToRead) {
        console.log('按当前标签/符号规则没有可朗读内容，跳过自动朗读');
        return;
      }
      console.log('自动朗读最终文本:', textToRead.substring(0, 100));
      const speakerName = getMessageSpeakerName(messageElement);
      const voiceForSpeaker = getVoiceForSpeaker(speakerName);
      if (speakerName) ttsLog("🎭 自动朗读说话人：" + speakerName + "，音色=" + voiceForSpeaker);
      generateTTS(textToRead, null, voiceForSpeaker);
      return;
      
      const textStart = $("#image_text_start").val();
      const textEnd = $("#image_text_end").val();
      
      console.log('检查标记:', { textStart, textEnd, 消息内容: message.substring(0, 100) });
      
      if (textStart && textEnd) {
        let extractedTexts = [];
        
        // 添加调试日志
        console.log('原始消息:', message);
        console.log('消息中的引号位置:');
        for (let i = 0; i < message.length; i++) {
          if (message[i] === '"' || message[i] === '"' || message[i] === '"' || message[i] === '"') {
            console.log(`位置${i}: "${message[i]}" (字符码: ${message[i].charCodeAt(0)})`);
          }
        }
        
        // 判断开始和结束符号是否相同（如英文引号）
        if (textStart === textEnd) {
          // 相同标记：使用更智能的配对算法
          let insideQuote = false;
          let currentText = '';
          let pairCount = 0;
          
          for (let i = 0; i < message.length; i++) {
            const char = message[i];
            
            if (char === textStart) {
              if (!insideQuote) {
                // 开始引号
                console.log(`位置${i}: 开始第${pairCount + 1}对引号`);
                insideQuote = true;
                currentText = '';
              } else {
                // 结束引号
                console.log(`位置${i}: 结束第${pairCount + 1}对引号，内容: "${currentText}"`);
                if (currentText.trim()) {
                  extractedTexts.push(currentText.trim());
                  pairCount++;
                  console.log(`提取第${pairCount}对引号内容:`, currentText.trim());
                }
                insideQuote = false;
                currentText = '';
              }
            } else if (insideQuote) {
              currentText += char;
            }
          }
        } else {
          // 不同标记：使用正则表达式
          const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const escapedStart = escapeRegex(textStart);
          const escapedEnd = escapeRegex(textEnd);
          
          const regex = new RegExp(`${escapedStart}(.*?)${escapedEnd}`, 'g');
          const matches = message.match(regex);
          
          if (matches && matches.length > 0) {
            console.log(`找到${matches.length}个标记内容`);
            
            matches.forEach(match => {
              const cleanText = match.replace(textStart, '').replace(textEnd, '').trim();
              if (cleanText) {
                extractedTexts.push(cleanText);
              }
            });
          }
        }
        
        if (extractedTexts.length > 0) {
          const finalText = extractedTexts.join(' ');
          console.log('自动朗读标记内文本:', finalText);
          generateTTS(finalText);
          return; // 重要：找到标记就不读全文
        }
        
        // 设置了标记但没找到匹配内容，不朗读
        console.log('设置了标记但未找到匹配内容，跳过朗读');
      } else {
        // 没有设置标记，朗读全文
        console.log('未设置标记，自动朗读全文:', message.substring(0, 100));
        console.log('开始生成TTS...');
        generateTTS(message);
      }
    }, 1000); // 延迟1000ms等待DOM完全更新，包括世界书和COT
  });
  
  // 用户消息监听
  eventSource.on(event_types.USER_MESSAGE_RENDERED, async (messageId) => {
    console.log('用户消息渲染:', messageId);
    
    // 防止重复处理同一条用户消息
    if (audioState.lastProcessedUserMessageId === messageId) {
      console.log('用户消息已处理，跳过:', messageId);
      return;
    }
    
    const autoPlayUser = $("#auto_play_user").prop("checked");
    if (!autoPlayUser) {
      console.log('用户消息自动朗读未开启');
      return;
    }
    console.log('用户消息自动朗读已开启');
    
    // 标记为已处理
    audioState.lastProcessedUserMessageId = messageId;
    
    setTimeout(() => {
      console.log('用户消息延时处理开始:', messageId);
      const messageElement = $(`.mes[mesid="${messageId}"]`);
      console.log('用户消息元素:', messageElement.length > 0 ? '找到' : '未找到');
      
      const message = getMessageSourceText(messageElement);
      console.log('用户消息内容长度:', message ? message.length : 0);
      if (!message) {
        console.log('用户消息内容为空');
        return;
      }

      const textToRead = prepareTextForTts(message);
      if (!textToRead) {
        console.log('用户消息按当前标签/符号规则没有可朗读内容，跳过自动朗读');
        return;
      }
      console.log('用户消息自动朗读最终文本:', textToRead.substring(0, 100));
      generateTTS(textToRead);
      return;
      
      const textStart = $("#image_text_start").val();
      const textEnd = $("#image_text_end").val();
      
      console.log('用户消息 - 检查标记:', { textStart, textEnd, 消息内容: message.substring(0, 100) });
      
      if (textStart && textEnd) {
        let extractedTexts = [];
        
        // 添加调试日志
        console.log('用户原始消息:', message);
        console.log('用户消息中的引号位置:');
        for (let i = 0; i < message.length; i++) {
          if (message[i] === '"' || message[i] === '"' || message[i] === '"' || message[i] === '"') {
            console.log(`位置${i}: "${message[i]}" (字符码: ${message[i].charCodeAt(0)})`);
          }
        }
        
        // 判断开始和结束符号是否相同（如英文引号）
        if (textStart === textEnd) {
          // 相同标记：使用更智能的配对算法
          let insideQuote = false;
          let currentText = '';
          let pairCount = 0;
          
          for (let i = 0; i < message.length; i++) {
            const char = message[i];
            
            if (char === textStart) {
              if (!insideQuote) {
                // 开始引号
                console.log(`用户消息 - 位置${i}: 开始第${pairCount + 1}对引号`);
                insideQuote = true;
                currentText = '';
              } else {
                // 结束引号
                console.log(`用户消息 - 位置${i}: 结束第${pairCount + 1}对引号，内容: "${currentText}"`);
                if (currentText.trim()) {
                  extractedTexts.push(currentText.trim());
                  pairCount++;
                  console.log(`用户消息 - 提取第${pairCount}对引号内容:`, currentText.trim());
                }
                insideQuote = false;
                currentText = '';
              }
            } else if (insideQuote) {
              currentText += char;
            }
          }
        } else {
          // 不同标记：使用正则表达式
          const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const escapedStart = escapeRegex(textStart);
          const escapedEnd = escapeRegex(textEnd);
          
          const regex = new RegExp(`${escapedStart}(.*?)${escapedEnd}`, 'g');
          const matches = message.match(regex);
          
          if (matches && matches.length > 0) {
            console.log(`用户消息 - 找到${matches.length}个标记内容`);
            
            matches.forEach(match => {
              const cleanText = match.replace(textStart, '').replace(textEnd, '').trim();
              if (cleanText) {
                extractedTexts.push(cleanText);
              }
            });
          }
        }
        
        if (extractedTexts.length > 0) {
          const finalText = extractedTexts.join(' ');
          console.log('用户消息 - 自动朗读标记内文本:', finalText);
          generateTTS(finalText);
          return;
        }
        
        // 设置了标记但没找到匹配内容，不朗读
        console.log('用户消息 - 设置了标记但未找到匹配内容，跳过朗读');
      } else {
        // 没有设置标记，朗读全文
        console.log('用户消息 - 未设置标记，自动朗读全文:', message.substring(0, 100));
        generateTTS(message);
      }
    }, 500);
  });

  // 给每条消息补上小喇叭按钮：消息渲染、切换聊天时各注入一次，再加兜底巡逻
  eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
    setTimeout(injectPlayButton, 200);
    setTimeout(ensurePersistentPlayerBar, 250);
  });
  eventSource.on(event_types.USER_MESSAGE_RENDERED, () => {
    setTimeout(injectPlayButton, 200);
    setTimeout(ensurePersistentPlayerBar, 250);
  });
  if (event_types.CHAT_CHANGED) {
    eventSource.on(event_types.CHAT_CHANGED, () => {
      setTimeout(injectPlayButton, 300);
      setTimeout(ensurePersistentPlayerBar, 350);
    });
  }
  setInterval(injectPlayButton, 2000);
}

// 克隆音色功能
async function uploadVoice() {
  const apiKey = extension_settings[extensionName].apiKey;
  const voiceName = $("#clone_voice_name").val();
  const voiceText = $("#clone_voice_text").val();
  const audioFile = $("#clone_voice_audio")[0].files[0];
  
  if (!apiKey) {
    toastr.error("请先配置API密钥", "克隆音色错误");
    return;
  }
  
  if (!voiceName || !voiceText || !audioFile) {
    toastr.error("请填写音色名称、参考文本并选择音频文件", "克隆音色错误");
    return;
  }
  
  // 验证音色名称格式
  const namePattern = /^[a-zA-Z0-9_-]+$/;
  if (!namePattern.test(voiceName)) {
    toastr.error("音色名称只能包含英文字母、数字、下划线和连字符", "格式错误");
    return;
  }
  
  if (voiceName.length > 64) {
    toastr.error("音色名称不能超过64个字符", "格式错误");
    return;
  }
  
  try {
    console.log("开始上传音色...");
    
    // 根据API文档，有两种方式上传：base64或文件
    // 先尝试用base64方式
    const reader = new FileReader();
    
    reader.onload = async function(e) {
      try {
        const base64Audio = e.target.result; // 这将包含 data:audio/mpeg;base64,xxx 格式
        
        // 使用JSON格式发送，因为API文档显示可以用base64
        const requestBody = {
          model: 'FunAudioLLM/CosyVoice2-0.5B',
          customName: voiceName,
          text: voiceText,
          audio: base64Audio // 直接使用完整的base64字符串，包含data:audio/mpeg;base64头
        };
        
        const response = await fetch(`${extension_settings[extensionName].apiUrl}/uploads/audio/voice`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody)
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error("Upload error response:", errorText);
          
          // 如果JSON方式失败，尝试FormData方式
          console.log("JSON上传失败，尝试FormData方式...");
          
          const formData = new FormData();
          formData.append('model', 'FunAudioLLM/CosyVoice2-0.5B');
          formData.append('customName', voiceName);
          formData.append('text', voiceText);
          
          // 创建一个Blob对象从base64
          const base64Data = base64Audio.split(',')[1];
          const byteCharacters = atob(base64Data);
          const byteNumbers = new Array(byteCharacters.length);
          for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
          }
          const byteArray = new Uint8Array(byteNumbers);
          const blob = new Blob([byteArray], {type: audioFile.type});
          
          formData.append('audio', blob, audioFile.name);
          
          const response2 = await fetch(`${extension_settings[extensionName].apiUrl}/uploads/audio/voice`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`
            },
            body: formData
          });
          
          if (!response2.ok) {
            throw new Error(`HTTP ${response2.status}: ${await response2.text()}`);
          }
          
          const data = await response2.json();
          console.log("音色上传成功(FormData):", data);
        } else {
          const data = await response.json();
          console.log("音色上传成功(JSON):", data);
        }
        
        // 清空输入
        $("#clone_voice_name").val("");
        $("#clone_voice_text").val("");
        $("#clone_voice_audio").val("");
        $("#clone_voice_audio_name").text("未选择音频");
        
        toastr.success(`音色 "${voiceName}" 克隆成功！`, "克隆音色");
        
        // 刷新音色列表
        await loadCustomVoices();
        
      } catch (error) {
        console.error("Voice Clone Error:", error);
        toastr.error(`音色克隆失败: ${error.message}`, "克隆音色错误");
      }
    };
    
    reader.readAsDataURL(audioFile);
    
  } catch (error) {
    console.error("Voice Clone Error:", error);
    toastr.error(`音色克隆失败: ${error.message}`, "克隆音色错误");
  }
}

// 获取自定义音色列表
async function loadCustomVoices() {
  const apiKey = extension_settings[extensionName].apiKey;
  
  if (!apiKey) return;
  
  try {
    const response = await fetch(`${extension_settings[extensionName].apiUrl}/audio/voice/list`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    console.log("自定义音色列表:", data);
    
    // 保存到设置 - 注意API返回的是result不是results
    extension_settings[extensionName].customVoices = data.result || data.results || [];
    
    // 打印第一个音色的结构以便调试
    if (extension_settings[extensionName].customVoices.length > 0) {
      console.log("第一个自定义音色结构:", extension_settings[extensionName].customVoices[0]);
    }
    
    // 更新UI显示
    updateCustomVoicesList();
    updateVoiceOptions();
    
  } catch (error) {
    console.error("Load Custom Voices Error:", error);
  }
}

// 更新自定义音色列表显示
function updateCustomVoicesList() {
  const customVoices = extension_settings[extensionName].customVoices || [];
  const listContainer = $("#custom_voices_list");
  
  if (customVoices.length === 0) {
    listContainer.html("<small>暂无自定义音色</small>");
    return;
  }
  
  let html = "";
  customVoices.forEach(voice => {
    const voiceName = voice.name || voice.customName || voice.custom_name || "未命名";
    const voiceUri = voice.uri || voice.id || voice.voice_id;
    html += `
      <div class="custom-voice-item" style="margin: 5px 0; padding: 5px; border: 1px solid #ddd; border-radius: 4px;">
        <span>${voiceName}</span>
        <button class="menu_button delete-voice" data-uri="${voiceUri}" data-name="${voiceName}" style="float: right; padding: 2px 8px; font-size: 12px;">删除</button>
      </div>
    `;
  });
  
  listContainer.html(html);
}

// 删除自定义音色
async function deleteCustomVoice(uri, name) {
  const apiKey = extension_settings[extensionName].apiKey;
  
  if (!apiKey) {
    toastr.error("请先配置API密钥", "删除音色错误");
    return;
  }
  
  if (!confirm(`确定要删除音色 "${name}" 吗？`)) {
    return;
  }
  
  try {
    const response = await fetch(`${extension_settings[extensionName].apiUrl}/audio/voice/deletions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ uri: uri })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    toastr.success(`音色 "${name}" 已删除`, "删除成功");
    
    // 刷新列表
    await loadCustomVoices();
    
  } catch (error) {
    console.error("Delete Voice Error:", error);
    toastr.error(`删除失败: ${error.message}`, "删除音色错误");
  }
}

// jQuery加载时初始化
jQuery(async () => {
  const settingsHtml = await $.get(`${extensionFolderPath}/example.html`);
  $("#extensions_settings").append(settingsHtml);
  
  // Inline drawer 折叠/展开功能 - 使用延迟绑定
  setTimeout(() => {
    $('.siliconflow-extension-settings .inline-drawer-toggle').each(function() {
      $(this).off('click').on('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        
        const $header = $(this);
        const $icon = $header.find('.inline-drawer-icon');
        const $content = $header.next('.inline-drawer-content');
        const isOpen = $content.data('open') === true;
        
        if (isOpen) {
          // 收起
          $content.data('open', false);
          $content.hide();
          $icon.removeClass('down');
        } else {
          // 展开
          $content.data('open', true);
          $content.show();
          $icon.addClass('down');
        }
      });
    });
  }, 100);
  
  // 绑定事件
  $("#save_siliconflow_settings").on("click", saveSettings);
  
  // 克隆音色功能事件
  $("#upload_voice").on("click", uploadVoice);
  $("#refresh_custom_voices").on("click", loadCustomVoices);
  $("#clone_voice_audio").on("change", function() {
    const file = this.files && this.files[0];
    $("#clone_voice_audio_name").text(file ? file.name : "未选择音频");
  });
  
  // 删除音色事件（使用事件委托）
  $(document).on("click", ".delete-voice", function() {
    const uri = $(this).data("uri");
    const name = $(this).data("name");
    deleteCustomVoice(uri, name);
  });
  
  // 自动保存复选框状态
  $("#auto_play_audio").on("change", function() {
    extension_settings[extensionName].autoPlay = $(this).prop("checked");
    saveSettingsDebounced();
    console.log("自动朗读角色消息:", $(this).prop("checked"));
  });
  
  $("#auto_play_user").on("change", function() {
    extension_settings[extensionName].autoPlayUser = $(this).prop("checked");
    saveSettingsDebounced();
    console.log("自动朗读用户消息:", $(this).prop("checked"));
  });
  
  // 符号设置自动保存
  $("#image_text_start, #image_text_end, #tts_symbol_outside_start, #tts_symbol_outside_end").on("input", function() {
    extension_settings[extensionName].textStart = $("#image_text_start").val();
    extension_settings[extensionName].textEnd = $("#image_text_end").val();
    extension_settings[extensionName].symbolOutsideStart = $("#tts_symbol_outside_start").val();
    extension_settings[extensionName].symbolOutsideEnd = $("#tts_symbol_outside_end").val();
    updateSymbolConflictUI();
    saveSettingsDebounced();
  });
  $("#tts_read_symbol_inside, #tts_read_symbol_outside").on("change", function() {
    extension_settings[extensionName].symbolReadInside = $("#tts_read_symbol_inside").prop("checked") === true;
    extension_settings[extensionName].symbolReadOutside = $("#tts_read_symbol_outside").prop("checked") === true;
    updateSymbolConflictUI();
    saveSettingsDebounced();
  });
  $("#tts_max_read_chars").on("input", function() {
    extension_settings[extensionName].ttsMaxReadChars = getTtsMaxReadChars();
    saveSettingsDebounced();
  });
  $("#tts_add_skip_tag").on("click", function() {
    addTagPairRow("skip");
  });
  $("#tts_add_read_tag").on("click", function() {
    addTagPairRow("read");
  });
  $("#tts_enable_extra_text_rules").on("change", function() {
    const enabled = $(this).prop("checked") === true;
    extension_settings[extensionName].extraTextRulesEnabled = enabled;
    updateExtraTextRulesUI(enabled);
    saveSettingsDebounced();
  });
  $(document).on("input", ".tts-tag-start", function() {
    const row = $(this).closest(".tts-tag-pair-row");
    const endInput = row.find(".tts-tag-end");
    const nextEnd = makeEndTagFromStart($(this).val());
    const previousAutoEnd = row.attr("data-auto-end") || "";
    if (!endInput.val().trim() || endInput.val().trim() === previousAutoEnd) {
      endInput.val(nextEnd);
      row.attr("data-auto-end", nextEnd);
    }
    updateTagPairPreview(row);
    extension_settings[extensionName].skipTagPairs = collectTagPairSettings("skip");
    extension_settings[extensionName].readTagPairs = collectTagPairSettings("read");
    saveSettingsDebounced();
  });
  $(document).on("input", ".tts-tag-end", function() {
    const row = $(this).closest(".tts-tag-pair-row");
    updateTagPairPreview(row);
    extension_settings[extensionName].skipTagPairs = collectTagPairSettings("skip");
    extension_settings[extensionName].readTagPairs = collectTagPairSettings("read");
    saveSettingsDebounced();
  });
  $(document).on("change", ".tts-tag-enabled", function() {
    extension_settings[extensionName].skipTagPairs = collectTagPairSettings("skip");
    extension_settings[extensionName].readTagPairs = collectTagPairSettings("read");
    saveSettingsDebounced();
  });
  $(document).on("click", ".tts-tag-remove", function() {
    $(this).closest(".tts-tag-pair-row").remove();
    extension_settings[extensionName].skipTagPairs = collectTagPairSettings("skip");
    extension_settings[extensionName].readTagPairs = collectTagPairSettings("read");
    saveSettingsDebounced();
  });
  $("#tts_read_untagged_with_required").on("change", function() {
    extension_settings[extensionName].readUntaggedWithRequired = $(this).prop("checked") === true;
    saveSettingsDebounced();
  });
  $("#test_siliconflow_connection").on("click", testConnection);
  $("#tts_model").on("change", updateVoiceOptions);
  $("#tts_voice").on("change", function() {
    extension_settings[extensionName].ttsVoice = $(this).val();
    console.log("选择的音色:", $(this).val());
    renderRoleVoiceMap();
  });
  $("#refresh_role_voices").on("click", function() {
    renderRoleVoiceMap();
    toastr.success("已刷新当前聊天角色", "多人音色");
  });
  $(document).on("change", ".tts-role-voice-select", function() {
    const roleName = $(this).closest(".sf-role-voice-row").data("role-name");
    const voice = $(this).val();
    extension_settings[extensionName].roleVoiceMap = extension_settings[extensionName].roleVoiceMap || {};
    if (voice) extension_settings[extensionName].roleVoiceMap[roleName] = voice;
    else delete extension_settings[extensionName].roleVoiceMap[roleName];
    saveSettingsDebounced();
  });
  $("#tts_speed").on("input", function() {
    $("#tts_speed_value").text($(this).val());
  });
  $("#tts_gain").on("input", function() {
    $("#tts_gain_value").text($(this).val());
  });
  
  // TTS测试按钮
  $("#test_tts").on("click", async function() {
    primeAudioOnce(); // 用户手势内解锁音频
    // 先保存当前选择的音色
    extension_settings[extensionName].ttsVoice = $("#tts_voice").val();
    const testText = $("#tts_test_text").val() || "你好，这是一个测试语音。";
    await generateTTS(testText);
  });
  
  // 加载设置
  await loadSettings();
  
  // 加载自定义音色列表
  await loadCustomVoices();
  
  // 设置消息监听器
  setupMessageListener();

  // 注入按钮高亮样式
  injectTTSStyle();

  // 启用点击事件委托（消息重绘也能接住点击）
  bindPlayButtonDelegation();

  // 首次触屏/点击时自动解锁移动端音频（只需成功一次，之后都能出声）
  $(document).on("pointerdown.ttsprime touchstart.ttsprime click.ttsprime", function () {
    primeAudioOnce();
    if (audioPrimed) $(document).off(".ttsprime");
  });

  // 初始化时给现有消息补上播放按钮
  setTimeout(injectPlayButton, 800);

  // 播放条：按开关决定是否常驻显示
  const barOn = shouldKeepPlayerBarVisible(); // 默认开
  if (barOn) {
    ensurePersistentPlayerBar();
    [600, 1500, 3000].forEach((ms) => setTimeout(ensurePersistentPlayerBar, ms));
  }
  setInterval(() => {
    injectPlayButton(); // ▶ 按钮始终维护
    const on = shouldKeepPlayerBarVisible();
    if (!on) return; // 开关关掉时不强制显示进度条
    if (!document.getElementById("tts-player-bar")) {
      ttsAudioEl = null;
      ensurePersistentPlayerBar();
    } else {
      ensurePersistentPlayerBar();
    }
  }, 2000);

  ttsLog("🟢 插件已加载。点消息上的 ▶ 看每一步日志。");
  
  console.log("硅基流动插件已加载");
  console.log("自动朗读功能已启用，请在控制台查看调试信息");
  console.log('事件源:', eventSource);
  console.log('事件类型:', event_types);
  console.log('角色消息事件:', event_types.CHARACTER_MESSAGE_RENDERED);
  console.log('用户消息事件:', event_types.USER_MESSAGE_RENDERED);
});

export { generateTTS };

