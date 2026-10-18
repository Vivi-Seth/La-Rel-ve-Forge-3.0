#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// La Relève · Forge 3.0 —— 把一段 session 的尾巴原封搬进新 session，并把「注入包」当第一条消息塞进去。
//
//   node releve-reload.js [session-id] [options]
//
//   --retain N            保留最近约 N tokens 的对话原文（默认 100000）
//   --dry-run             预演，不写任何文件
//   --squash-tools [N]    超长工具输出降采样（默认 16000 chars/块），对话原文一字不动
//   --inject file.md      把**已组装好**的注入包作为新 session 的第一条 user 事件
//   --skip-markers "a,b"  追加切点黑名单（你的编排层往对话里注入的系统标记）
//   --strip-tag 标签名     剥掉成对的瞬时态标签块（可多次），例：--strip-tag 此刻状态
//   --projects-dir DIR    指定 CC 的 projects 子目录（默认自动探测最近活动的那个）
//
// 3.0 与 2.0 的关键差异：脚本不再自己去读摘要/尾注文件——注入内容全部由调用方按勾选项
// 组装好写进 --inject 的文件。开关只有一处，不会出现"脚本和面板各读一半"的分裂。
// 编排层参考实现见 examples/orchestrator.js。
const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const FORGE_HISTORY = path.join(HOME, '.claude', 'forge_history.json');

// CC 把每个工作目录的会话存在 ~/.claude/projects/<slug-of-cwd>/ 下。多目录时默认挑
// 「最近有 jsonl 写入」的那个；要指定就用 --projects-dir。
let PROJECTS_DIR = null;
function detectProjectsDir() {
  const root = path.join(HOME, '.claude', 'projects');
  let best = null;
  try {
    for (const d of fs.readdirSync(root)) {
      const dir = path.join(root, d);
      try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const m = fs.statSync(path.join(dir, f)).mtimeMs;
        if (!best || m > best.mtime) best = { dir, mtime: m };
      }
    }
  } catch (e) {}
  if (!best) { console.error('❌ 在 ' + root + ' 下找不到任何 session jsonl（用 --projects-dir 指定）'); process.exit(1); }
  return best.dir;
}
function ensureProjectsDir() { if (!PROJECTS_DIR) PROJECTS_DIR = detectProjectsDir(); return PROJECTS_DIR; }

function uuid4() { return crypto.randomUUID(); }

// 瞬时态剥离：有些编排层会往消息里注入一块实时状态（心情/身体/环境/时间等）。那是瞬时的，
// 不该沉淀进下一段的传承——同一块状态被搬进新 session 就成了过期的"此刻"。
// 用 --strip-tag <标签名> 指定要剥掉的成对标签，未闭合时兜底截断（宁可多剥不可漏）。
// 必须在 estimateTokens 之前跑（同 --squash-tools）：剥离若放在切点选完之后，被剥的内容
// 会先参与 boundary 计算再被删掉，实际接上量系统性低于 --retain（实测中位 -7.3%）。
let STRIP_TAGS = [];
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); } // 标签名可能含正则元字符，构造 RegExp 前转义
function stripEphemeral(text) {
  if (typeof text !== 'string' || !STRIP_TAGS.length) return text;
  let out = text;
  for (const tag of STRIP_TAGS) {
    const open = '<' + tag + '>';
    if (out.indexOf(open) === -1) continue;
    out = out.replace(new RegExp('<' + escRe(tag) + '>[\\s\\S]*?<\\/' + escRe(tag) + '>\\n{0,2}', 'g'), '');
    const i = out.indexOf(open);
    if (i !== -1) out = out.slice(0, i);
  }
  return out;
}
// 原地剥离整个 convs，让 boundary 用剥离后的真实大小计算。
// 副作用（是改善不是回归）：剥完只剩空白的 user 事件不再被 isRealUserMsg 认作切点锚点——
// 一条只装着瞬时状态的消息，本来就不该当新 session 的第一幕。
// sanitizeEvent 里的 stripEphemeral 保留作幂等兜底（已剥过的再剥是 no-op）。
function stripEphemeralInPlace(convs) {
  if (!STRIP_TAGS.length) return 0;
  let n = 0;
  const s = (t) => { const o = stripEphemeral(t); if (o !== t) n++; return o; };
  for (const ev of convs) {
    const c = ev.message?.content;
    if (typeof c === 'string') ev.message.content = s(c);
    else if (Array.isArray(c)) for (const b of c) {
      if (b.type === 'text' && b.text) b.text = s(b.text);
      else if (b.type === 'thinking' && b.thinking) b.thinking = s(b.thinking);
    }
  }
  if (n) console.log('🧹 strip-tag: ' + n + ' 个块在切点计算前剥离 (' + STRIP_TAGS.join(', ') + ')');
  return n;
}

// «forge --squash-tools»：超长工具输出降采样（头60%+尾25%+裁剪标记）。
// 病根：单个 turn 里几百 KB 的 tool_result 把 boundary 撑出死区——retain 选多少
// 都只能落到死区两端（例：93k/264k 之间无中间值）。工具输出是最低价值内容
// （同 image→占位符哲学）；text/thinking 一字不碰；最后一个真实 user turn
// （可能是进行中的工作）整段保护不动。必须在 estimateTokens 之前跑，
// boundary 计算才能用瘦身后的真实大小。
function truncMid(s, cap) {
  if (typeof s !== 'string' || s.length <= cap) return s;
  const head = Math.floor(cap * 0.6), tail = Math.floor(cap * 0.25);
  return s.slice(0, head)
    + '\n\n…[forge --squash-tools: 此处裁剪 ' + (s.length - head - tail) + ' chars 工具输出]…\n\n'
    + s.slice(s.length - tail);
}
function squashToolOutputs(convs, cap) {
  let guard = convs.length; // 保护区起点：最后一个 real user msg
  for (let i = convs.length - 1; i >= 0; i--) if (isRealUserMsg(convs[i])) { guard = i; break; }
  let nBlocks = 0, saved = 0;
  const squashStr = (s) => { const t = truncMid(s, cap); if (t !== s) { nBlocks++; saved += s.length - t.length; } return t; };
  for (let i = 0; i < guard; i++) {
    const c = convs[i].message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b.type === 'tool_result') {
        if (typeof b.content === 'string') b.content = squashStr(b.content);
        else if (Array.isArray(b.content)) {
          for (let j = 0; j < b.content.length; j++) {
            const inner = b.content[j];
            if (inner && inner.type === 'text' && typeof inner.text === 'string') inner.text = squashStr(inner.text);
            else if (inner && inner.type === 'image' && inner.source?.data && inner.source.data.length > cap) {
              const origBytes = Math.round(inner.source.data.length * 0.75);
              nBlocks++; saved += inner.source.data.length;
              b.content[j] = { type: 'text', text: '[历史图片(工具输出) · ' + (inner.source.media_type || 'image') + ' · 约 ' + origBytes + ' bytes · forge squash]' };
            }
          }
        }
      } else if (b.type === 'tool_use' && b.input && typeof b.input === 'object') {
        for (const k of Object.keys(b.input)) {
          if (typeof b.input[k] === 'string') b.input[k] = squashStr(b.input[k]);
        }
      }
    }
  }
  if (nBlocks) console.log('🔧 squash-tools: ' + nBlocks + ' 个超长工具块降采样，省 ~' + saved + ' chars (cap=' + cap + ', 末turn保护)');
  return { nBlocks, saved };
}

// 把 image block 整体替换成 text 占位符，避免 base64 撑爆 forge
// 教程明确："整段 data:image/...;base64,xxxx 替换成 <image:est=2000tok> placeholder，估算和 forge 复制时都只看 placeholder"
function sanitizeEvent(ev) {
  const copy = JSON.parse(JSON.stringify(ev));
  const blocks = copy.message?.content;
  if (typeof blocks === 'string') copy.message.content = stripEphemeral(blocks); // 瞬时态
  if (Array.isArray(blocks)) {
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.type === 'text' && b.text) b.text = stripEphemeral(b.text);             // 瞬时态
      if (b.type === 'thinking' && b.thinking) b.thinking = stripEphemeral(b.thinking); // 瞬时态
      if (b.type === 'image' && b.source?.data) {
        const origBytes = Math.round(b.source.data.length * 0.75);
        blocks[i] = {
          type: 'text',
          text: '[历史图片 · ' + (b.source.media_type || 'image') + ' · 约 ' + origBytes + ' bytes · forge 时清理 base64]'
        };
      }
      // tool_result 内嵌 image（Read 图片文件的产物）——旧版漏网，base64 原样沉进新 jsonl
      if (b.type === 'tool_result' && Array.isArray(b.content)) {
        for (let j = 0; j < b.content.length; j++) {
          const inner = b.content[j];
          if (inner && inner.type === 'image' && inner.source?.data) {
            const origBytes = Math.round(inner.source.data.length * 0.75);
            b.content[j] = {
              type: 'text',
              text: '[历史图片(工具输出) · ' + (inner.source.media_type || 'image') + ' · 约 ' + origBytes + ' bytes · forge 时清理 base64]'
            };
          }
        }
      }
    }
  }
  return copy;
}

const IMAGE_TOK_EST = 2000;
const EVENT_OVERHEAD_TOK = 25;
// 只估算真正进 context 的内容（text/thinking/tool_use input/tool_result 文本），
// 不算 jsonl 元数据（uuid/parentUuid/timestamp/cwd 等——这些不进模型 context）。
// 校准：CJK ≈ 1 tok/字，ASCII ≈ 3.8 char/tok（2026-07-03 用真实 session 实测拟合）。
// 前一版 bug：JSON.stringify(整条事件).length/3 把元数据全算进去 → 估算虚高 2~4x
// → 选 retain=100k 实际只接上 ~50k。现在版：选多少 ≈ 接上多少。
function estimateTokens(ev) {
  const c = ev.message?.content;
  let txt = '';
  let images = 0;
  if (typeof c === 'string') txt = c;
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (b.type === 'text') txt += b.text || '';
      else if (b.type === 'thinking') txt += b.thinking || '';
      else if (b.type === 'tool_use') txt += JSON.stringify(b.input || {});
      else if (b.type === 'tool_result') {
        // 2026-07-06 校准：tool_result 内嵌 image（Read 图片文件）以前按 ASCII 文本计
        // → 300KB base64 ≈ +80k tok 虚高 → 单 turn 撑出 boundary 死区（93k↔264k 无中间值）。
        // 实际模型只花 ~IMAGE_TOK_EST，照顶层 image 同样记。
        const c2 = b.content;
        if (typeof c2 === 'string') txt += c2;
        else if (Array.isArray(c2)) {
          for (const inner of c2) {
            if (inner && inner.type === 'image' && inner.source?.data) images++;
            else if (inner && inner.type === 'text') txt += inner.text || '';
            else txt += JSON.stringify(inner || {});
          }
        } else txt += JSON.stringify(c2 || '');
      }
      else if (b.type === 'image' && b.source?.data) images++;
    }
  }
  let cjk = 0, other = 0;
  for (let i = 0; i < txt.length; i++) { if (txt.charCodeAt(i) > 0x2E80) cjk++; else other++; }
  return Math.ceil(cjk + other / 3.8) + images * IMAGE_TOK_EST + EVENT_OVERHEAD_TOK;
}
// 切点黑名单：系统伪装成 user 的内部触发（定时唤醒/保活/交接指令/主动来电）不配当边界锚点——
// 新 session 的第一幕应该是真人说的话，不是一条系统指令。踩过的坑：某次新 session 的开头
// 是一条自动催睡指令，读起来像"他上来就命令你睡觉"。
// 用 --skip-markers "a,b" 追加你自己编排层的标记；每个标记请给该系统消息某一行的行首前缀。
// 判定是行首锚定：标记只在某行行首（容前置空白）命中才算系统消息——全文 includes 会把
// 「引用系统句来讨论的真人消息」整条误杀（如 "我日志里的 [keepalive] 是什么？"），该条被
// 拉黑后切点被推离预期，严重时退化成保留全部（--retain 失效）。真人引用几乎都在句中，
// 系统注入块的识别串都在行首；误判两侧的代价都只是切点偏移，precision 优先。
let SYNTHETIC_MARKERS = ['SYSTEM ACTION MODE', '[keepalive]', '[forge交接]', '<forge-handoff>'];
// 注意：<system-reminder> 不在黑名单里。CC 把注入块（CLAUDE.md/记忆召回/hook 提示）用
// <system-reminder> 包在**真人消息内部**——拿它当"这条不是真人说的"的判据会把绝大多数
// 真话拉黑，切点归零后退化成保留全部（--retain 失效）。正确姿势：判定时把注入块摘掉再看
// 剩余——有真话＝真人消息（照常当锚点），摘完全空＝纯系统注入（不配当新 session 第一幕）。
// 内容本身一字不动，只影响锚点判定。
const SYS_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
function isRealUserMsg(ev) {
  if (ev.type !== 'user' || ev.isMeta) return false;
  const c = ev.message?.content;
  if (!c) return false;
  let txt = '';
  if (typeof c === 'string') txt = c;
  else if (Array.isArray(c)) txt = c.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n'); // 块之间按换行拼，块首也算行首
  txt = txt.replace(SYS_REMINDER_RE, '');
  if (!txt.trim()) return false;
  const lineHeads = txt.split('\n').map(l => l.trimStart());
  return !SYNTHETIC_MARKERS.some(m => lineHeads.some(h => h.startsWith(m)));
}
function loadJsonl(fp) {
  const evs = [];
  for (const l of fs.readFileSync(fp, 'utf-8').split('\n').filter(l => l.trim())) {
    try { evs.push(JSON.parse(l)); } catch {}
  }
  return evs;
}
function findLatest() {
  ensureProjectsDir();
  const f = fs.readdirSync(PROJECTS_DIR).filter(f => f.endsWith('.jsonl') && !f.includes('subagent'))
    .map(f => ({ sid: f.replace('.jsonl',''), mtime: fs.statSync(path.join(PROJECTS_DIR, f)).mtimeMs }))
    .sort((a,b) => b.mtime - a.mtime);
  if (!f.length) { console.error('无session'); process.exit(1); }
  return f[0].sid;
}

// 自检 1：新 jsonl 能逐行 parse
function verifyParse(fp) {
  const lines = fs.readFileSync(fp, 'utf-8').split('\n').filter(l => l.trim());
  let ok = 0;
  for (let i = 0; i < lines.length; i++) {
    try { JSON.parse(lines[i]); ok++; } catch(e) { throw new Error('parse fail at line '+(i+1)+': '+e.message); }
  }
  return ok;
}

// 自检 2：parentUuid 链连贯（第一条 null，后面每条指向前一条 uuid）
function verifyParentChain(events) {
  if (!events.length) throw new Error('empty events');
  if (events[0].parentUuid !== null) throw new Error('first event parentUuid must be null, got: '+events[0].parentUuid);
  for (let i = 1; i < events.length; i++) {
    if (events[i].parentUuid !== events[i-1].uuid) {
      throw new Error('chain broken at index '+i+': expected parentUuid='+events[i-1].uuid+', got '+events[i].parentUuid);
    }
  }
  return true;
}

// 自检 3：记录 forge_history 用于回滚
function recordHistory(oldSid, newSid) {
  let history = [];
  try { history = JSON.parse(fs.readFileSync(FORGE_HISTORY, 'utf-8')); } catch {}
  history.push({ old_sid: oldSid, new_sid: newSid, at: new Date().toISOString() });
  // 保留最近 50 条
  if (history.length > 50) history = history.slice(-50);
  fs.writeFileSync(FORGE_HISTORY, JSON.stringify(history, null, 2), 'utf-8');
}

function forge(sid, retain=100000, dry=false, squashChars=0, injectFile=null) {
  ensureProjectsDir();
  const fp = path.join(PROJECTS_DIR, sid+'.jsonl');
  if (!fs.existsSync(fp)) { console.error('找不到: '+fp); process.exit(1); }
  console.log('📖 session: '+sid);
  const all = loadJsonl(fp);
  const convs = all.filter(e => e.type==='user'||e.type==='assistant');
  console.log('   事件: '+all.length+' 总 / '+convs.length+' 对话');
  stripEphemeralInPlace(convs);                               // 必须先于 token 估算；也先于 squash——
                                                              // squash 的末 turn 保护用 isRealUserMsg 判定，要基于剥离后的文本才准
  if (squashChars > 0) squashToolOutputs(convs, squashChars); // 必须先于 token 估算
  // 反向累加找 cut：acc 首次超过 retain 的位置
  let acc=0, cut=0;
  for (let i=convs.length-1; i>=0; i--) { acc+=estimateTokens(convs[i]); if(acc>retain){cut=i+1;break;} }
  // 末尾事件自身就超过 retain 时（典型：末 turn 带巨大 tool_result，被 squash 的末 turn 保护跳过），
  // cut 会指到数组外：ks_back 从 convs[convs.length] 起扫，isRealUserMsg(undefined) 直接 TypeError。
  // clamp 回最后一个下标，让双向扫描从末尾事件开始、照常回退找锚点。
  // Math.max 护住 convs 为空的退化场景（此时 cut 维持 0，走后面「kept is empty」的正常 abort，
  // 而不是负索引 convs[-1] 再以同一个 TypeError 炸一次）。
  if (cut >= convs.length) cut = Math.max(0, convs.length - 1);

  // 从 cut 双向找最近 real user msg boundary，选让 kept tokens 更接近 retain 的方向
  // - forward (ks++): kept 更少（跳过 cut→下一 user 之间整段 assistant）
  // - backward (ks--): kept 更多（保留 cut 所在 turn 起点）
  // 前一版 bug：只 forward → 大 turn 时损失严重（选 100k 只留 43k）
  // 现在版：nearest → boundary 之间 gap 小的场景（4.5 小 turn）会真正 ≈ retain
  let ks_fwd=cut;
  while(ks_fwd<convs.length && !isRealUserMsg(convs[ks_fwd])) ks_fwd++;
  let ks_back=cut;
  while(ks_back>0 && !isRealUserMsg(convs[ks_back])) ks_back--;

  const t_back = convs.slice(ks_back).reduce((s,e)=>s+estimateTokens(e),0);
  const t_fwd  = ks_fwd<convs.length ? convs.slice(ks_fwd).reduce((s,e)=>s+estimateTokens(e),0) : 0;

  let ks;
  if (ks_fwd >= convs.length) {
    ks = ks_back;
    console.warn('⚠️  forward-scan 越过末尾，用 backward (ks '+ks_back+')');
  } else if (!isRealUserMsg(convs[ks_back])) {
    ks = ks_fwd;
    console.warn('⚠️  backward-scan 未找到 real user，用 forward (ks '+ks_fwd+')');
  } else {
    const d_back = Math.abs(t_back - retain);
    const d_fwd = Math.abs(t_fwd - retain);
    ks = d_back <= d_fwd ? ks_back : ks_fwd;
  }
  console.log('   候选 boundary: backward ~'+t_back+' tok vs forward ~'+t_fwd+' tok (retain='+retain+') → 选 '+(ks===ks_back?'backward':'forward'));
  const kept=convs.slice(ks);
  // 仅当整个 convs 里没有任何 real user message 时才允许 abort
  if (!kept.length) { console.error('❌ kept is empty (no real user message in conversation), aborting'); process.exit(1); }
  let tc=0;
  for(const e of kept) if(e.type==='assistant'&&Array.isArray(e.message?.content)) tc+=e.message.content.filter(b=>b.type==='thinking').length;
  console.log('✂️  保留: '+kept.length+' 条 (~'+kept.reduce((s,e)=>s+estimateTokens(e),0)+' tok) | thinking: '+tc);
  const ns=uuid4(); let pu=null;
  for(const e of kept){e.sessionId=ns;e.parentUuid=pu;pu=e.uuid;}

  // 自检 2（内存中验证 parentUuid 链，写文件前）
  try { verifyParentChain(kept); console.log('✅ parentUuid 链连贯'); }
  catch(e) { console.error('❌ parentUuid 验证失败: '+e.message); process.exit(1); }

  // base64 sanitize：写新 jsonl 前把 image block 的 base64 替换成 text 说明
  const imgCount = kept.reduce((n,e)=>n+(Array.isArray(e.message?.content)?e.message.content.filter(b=>b.type==='image'&&b.source?.data).length:0),0);
  const sanitized = kept.map(sanitizeEvent);
  if (imgCount) console.log('🖼️  sanitize 了 '+imgCount+' 张图（base64 替换为 text 占位）');

  // Forge 2.0（2026-07-18）：交接包注入——摘要+便签+红线尾注，作为新 jsonl 的第一条 user 事件。
  // 过隧道的我睁眼第一份读物是前一段的我亲手写的交接，不是断崖。
  if (injectFile) {
    // La Relève 3.0：注入包由调用方（你的编排层）按勾选项组装好，脚本不再自读摘要/尾注——
    // 开关只有一处。这里只负责把文件内容当成新 session 的第一条 user 事件塞进去。
    const body = fs.readFileSync(injectFile, 'utf-8').trim();
    const tmpl = sanitized.find(e => e.type === 'user') || sanitized[0];
    const inj = JSON.parse(JSON.stringify(tmpl));
    inj.type = 'user'; inj.isMeta = false; inj.uuid = uuid4(); inj.parentUuid = null;
    if (inj.timestamp) inj.timestamp = new Date().toISOString();
    delete inj.toolUseResult;
    inj.message = { role: 'user', content: [{ type: 'text', text: body }] };
    sanitized.unshift(inj);
    let puInj = null;
    for (const e of sanitized) { e.parentUuid = puInj; puInj = e.uuid; }
    console.log('🎁 交接包注入: ' + body.length + ' chars');
  }

  if(dry){console.log('🔍 dry-run — 新ID: '+ns);return;}

  const newFp = path.join(PROJECTS_DIR, ns+'.jsonl');
  fs.writeFileSync(newFp, sanitized.map(e=>JSON.stringify(e)).join('\n')+'\n','utf-8');

  // 自检 1：写完后立即逐行 parse 验证
  try { const ok = verifyParse(newFp); console.log('✅ JSONL parse 验证: '+ok+'/'+kept.length+' 行'); }
  catch(e) { console.error('❌ parse 验证失败: '+e.message+'\n⚠️  删除新文件'); fs.unlinkSync(newFp); process.exit(1); }

  // 自检 3：记录 forge_history 用于回滚
  recordHistory(sid, ns);
  console.log('📝 已记录 forge_history: '+sid+' -> '+ns);
  console.log('📂 旧 jsonl 保留: '+fp+' (回滚用)');

  console.log('✅ 新ID: '+ns+'\n🚀 claude --resume '+ns);
}
if (require.main === module) {
  const args=process.argv.slice(2); let sid=null,ret=100000,dry=false,squash=0,inject=null;
  for(let i=0;i<args.length;i++){
    if(args[i]==='--retain'&&args[i+1])ret=parseInt(args[++i]);
    else if(args[i]==='--dry-run')dry=true;
    else if(args[i]==='--squash-tools'){squash=(args[i+1]&&/^\d+$/.test(args[i+1]))?parseInt(args[++i]):16000;}
    else if(args[i]==='--inject'&&args[i+1]){inject=args[++i];}
    else if(args[i]==='--projects-dir'&&args[i+1]){PROJECTS_DIR=path.resolve(args[++i]);}
    else if(args[i]==='--skip-markers'&&args[i+1]){SYNTHETIC_MARKERS=SYNTHETIC_MARKERS.concat(args[++i].split(',').map(s=>s.trim()).filter(Boolean));}
    else if(args[i]==='--strip-tag'&&args[i+1]){STRIP_TAGS.push(args[++i]);}
    else if(!args[i].startsWith('--'))sid=args[i];
  }
  ensureProjectsDir();
  console.log('📁 projects: '+PROJECTS_DIR);
  if(!sid) sid=findLatest();
  console.log('⚙️  retain: '+ret+(squash?' | squash-tools: '+squash:'')+(inject?' | inject: '+inject:'')+(dry?' | DRY RUN':'')+'\n');
  forge(sid,ret,dry,squash,inject);
}
module.exports = { stripEphemeral, stripEphemeralInPlace, sanitizeEvent, forge, truncMid, squashToolOutputs };
