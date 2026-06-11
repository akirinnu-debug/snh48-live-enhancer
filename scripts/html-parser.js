// ========== SNH48 Live Enhancer - HTML 解析工具模块 ==========
// 从 background.js 拆分：HTML 解析、成员提取、日期/团名解析等

var SNH48_BG = self.SNH48_BG || (self.SNH48_BG = {});

// [FIX 4.3] 增强版 HTML 解析
// 真实页面结构（已验证多种版本）：
//   2020+ 新版：<span class="title1">《因为喜欢你》剧场公演</span>
//             <span class="title2">作品展演：柏绚妤、刘思正 2026-06-07 19:05:00</span>
//   2017 旧版：<span class="title1">《因为喜欢你》剧场公演</span>
//             <span class="title2">TeamJ剧场公演 2017-11-26 14:00:00</span>
//             <ul class="memberlist">...</ul>  // 人气榜，非参演成员
//   2018 过渡：可能使用 <div class="titles"> 或带 h1/h2 标题
// [FIX 4.2] 旧版公演虽然 .title2 无"作品展演"前缀，但页面可能仍有 .imglist
//             旧版 .imglist 也在 <div class="imglist"> 内，需要兼容
function parseHtmlSimple(html, url) {
  // ---- [FIX 4.3] 提取标题：多模式兼容 + [P1-1.4.4] 回退模式增强 ----
  var title = "";

  // [P1-1.4.4] 主模式: <span class="title1">
  var title1Match = html.match(/<span\s+class="title1"[^>]*>([\s\S]*?)<\/span>/);
  if (title1Match) {
    title = stripHtml(title1Match[1]).trim();
  }

  // [P1-1.4.4] 回退模式1: <span class="title">
  if (!title) {
    var titleSpanMatch = html.match(/<span\s+class=["']title["'][^>]*>([\s\S]*?)<\/span>/i);
    if (titleSpanMatch) title = stripHtml(titleSpanMatch[1]).trim();
  }

  // [P1-1.4.4] 回退模式2: <h1> ~ <h6>
  if (!title) {
    var hMatch = html.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
    if (hMatch) title = stripHtml(hMatch[1]).trim();
  }

  // [P1-1.4.4] 回退模式3: <title> 标签
  if (!title) {
    var titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleTag) title = stripHtml(titleTag[1]).trim().split(/[_\-—|/]/)[0].trim();
  }

  // 模式5: <div class="titles"> 内的 h1
  if (!title) {
    var titlesMatch = html.match(/<div[^>]*class=["']titles["'][^>]*>[\s\S]*?<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (titlesMatch) title = stripHtml(titlesMatch[1]).trim();
  }

  // ---- 提取副标题：.title2 ----
  var subtitle = "";
  var title2Match = html.match(/<span[^>]*class=["']title2["'][^>]*>([\s\S]*?)<\/span>/i);
  if (title2Match) {
    subtitle = stripHtml(title2Match[1]).trim();
  }

  // ---- [FIX v4] 提取参演成员：全面重写 ----
  // 三层数据来源：A) subtitle 关键词  B) title 内嵌  C) .memberlist DOM
  var performers = [];

  // [L1 FIX] 清除零宽字符的工具函数
  function stripInvisibleChars(s) {
    return String(s).replace(/[\u200B-\u200D\uFEFF\u2060\u2028-\u2029\u00AD]/g, "").trim();
  }

  // [L1+L2 FIX] 宽松关键词匹配：用 includes 替代 indexOf，兼容零宽字符和变体前缀
  function tryExtractKeywords(text, keywords) {
    if (!text) return [];
    var clean = stripInvisibleChars(text);
    if (!clean) return [];

    for (var i = 0; i < keywords.length; i++) {
      var kw = keywords[i];
      // 在清理后的文本中查找关键词（放宽：用 includes 而非 starts-with）
      var idx = clean.indexOf(kw);
      if (idx === -1) continue;
      // 从关键词后面截取
      var after = clean.substring(idx + kw.length);
      // 跳过冒号类字符和空白
      after = after.replace(/^[：:﹕∶\s]+/, "");
      if (!after) continue;
      // 按分隔符提取成员名
      var found = parsePerformerList(after);
      if (found.length > 0) return found;
    }
    return [];
  }

  // 来源 A：subtitle 关键词提取
  var textBeforeDate = subtitle;
  var dateBoundary = subtitle.match(/\s+\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/);
  if (dateBoundary) {
    textBeforeDate = subtitle.substring(0, dateBoundary.index).trim();
  }

  // 按优先级尝试关键词列表（支持变体前缀，如"年度青春盛典作品展演"匹配"作品展演"）
  performers = tryExtractKeywords(textBeforeDate, [
    "作品展演",          // 覆盖 "作品展演" 和 "年度青春盛典作品展演"
    "参加成员",          // "参加成员：xxx xxx xxx"
    "出演",
    "参演"
  ]);

  // 来源 C [L5 FIX]：<ul class="memberlist"> → <li> → <p class="listname">
  var memberListMatch = null;
  if (performers.length === 0) {
    memberListMatch = html.match(/<ul[^>]*class=["'][^"']*memberlist[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i);
    if (memberListMatch) {
      // 提取所有 .listname 内的文本
      var listNameRegex = /<p[^>]*class=["'][^"']*listname[^"']*["'][^>]*>([\s\S]*?)<\/p>/gi;
      var ml;
      while ((ml = listNameRegex.exec(memberListMatch[1])) !== null) {
        var memberName = stripHtml(ml[1]).trim();
        if (memberName && memberName.length < 20 && performers.indexOf(memberName) === -1) {
          performers.push(memberName);
        }
      }
    }
    // [P1-1.4.4] 回退：主模式未匹配时，尝试从"成员：xxx"文本提取
    if (!memberListMatch) {
      memberListMatch = html.match(/成员[：:]\s*([\s\S]*?)(?:<\/div>|<\/p>|<br)/i);
      if (memberListMatch) {
        var fallbackNames = parsePerformerList(stripHtml(memberListMatch[1]));
        fallbackNames.forEach(function(n) {
          if (n && n.length < 20 && performers.indexOf(n) === -1) {
            performers.push(n);
          }
        });
      }
    }
  }

  // 旧 imglist 兼容（保留，但降低优先级到 memberlist 之后）
  if (performers.length === 0) {
    var imglistMatch = html.match(/<div[^>]*class=["'][^"']*imglist[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*(?:<div|<ul|<\/div>\s*<script)/i);
    if (imglistMatch) {
      var nameRegex = /<div[^>]*class=["'][^"']*imgbox[^"']*["'][^>]*>[\s\S]*?<[^>]*class=["'][^"']*name[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/gi;
      var mn;
      while ((mn = nameRegex.exec(imglistMatch[1])) !== null) {
        var n = stripHtml(mn[1]).trim();
        if (n && n.length < 20 && performers.indexOf(n) === -1) performers.push(n);
      }
    }
  }

  // 来源 B [L3 FIX]：title 中可能含成员名（如"宁轲生日"→"宁轲"，"xxx作品展演"→xxx）
  if (performers.length === 0) {
    // 尝试从 title 提取"xxx生日"和"xxx作品展演"模式
    var titleClean = stripInvisibleChars(title);
    // birthday pattern: "xxx生日公演" / "xxx生日环节" / "xxx生日会"
    var bdayMatch = titleClean.match(/([^\s《》〈〉]+?)(?:生日公演|生日环节|生日会|生日)/);
    if (bdayMatch) {
      var bdayName = bdayMatch[1].replace(/&amp;/g, "&").trim();
      if (bdayName && bdayName.length < 20 && performers.indexOf(bdayName) === -1) {
        performers.push(bdayName);
      }
    }
    // "xxx作品展演" pattern in title
    var titlePerf = tryExtractKeywords(titleClean, ["作品展演", "出演", "参演"]);
    performers = performers.concat(titlePerf);
  }

  // ---- 提取日期 ----
  var dateStr = "";
  var dateMatches = subtitle.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (!dateMatches) dateMatches = title.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (!dateMatches) dateMatches = subtitle.match(/(\d{4})\u5E74(\d{1,2})\u6708(\d{1,2})\u65E5/);
  if (!dateMatches) dateMatches = title.match(/(\d{4})\u5E74(\d{1,2})\u6708(\d{1,2})\u65E5/);
  if (dateMatches) {
    dateStr = dateMatches[1] + "-" + String(dateMatches[2]).padStart(2, "0") + "-" + String(dateMatches[3]).padStart(2, "0");
  }

  // ---- 提取团名 ----
  var team = "";
  // 支持 Team SII / Team NIII / Team G / Team Z / Team CII 等格式
  var teamMatch = subtitle.match(/Team\s*([A-Z]+(?:I+)?)/i);
  if (teamMatch) team = "Team " + teamMatch[1];

  // ---- [P1-1.4.4] 解析结果验证与诊断 ----
  var result = { title, subtitle, performers, date: dateStr, team };

  if (!result.title || result.title.trim() === '') {
    result.parseStatus = 'parse_failed';
    result.parseDiagnosis = {
      url: url,
      titleMatch: !!html.match(/<span\s+class="title1"[^>]*>([\s\S]*?)<\/span>/),
      titleSpanMatch: !!html.match(/<span\s+class=["']title["'][^>]*>([\s\S]*?)<\/span>/i),
      hMatch: !!html.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i),
      titleTagMatch: !!html.match(/<title[^>]*>([\s\S]*?)<\/title>/i),
      memberListMatch: !!html.match(/<ul[^>]*class=["'][^"']*memberlist[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i),
      htmlLength: html.length,
      htmlSnippet: html.substring(0, 500)
    };
    console.warn(`[SNH48-Enhancer] 解析失败: ${url}`, result.parseDiagnosis);
  } else {
    result.parseStatus = 'ok';
  }

  return result;
}

// 辅助：剥离 HTML 标签
function stripHtml(s) {
  return String(s).replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

// 辅助：解析成员名列表（支持 、 ， , 等多种分隔符）
function parsePerformerList(text) {
  if (!text) return [];
  return text
    .split(/[、，,\s]+/)
    .map(n => n.replace(/剧场公演|特别公演/g, "").trim())
    .filter(n => n && n.length > 0 && n.length < 20 && !/^[\d\W]+$/.test(n));
}

// 导出
SNH48_BG.parseHtmlSimple = parseHtmlSimple;
SNH48_BG.stripHtml = stripHtml;
SNH48_BG.parsePerformerList = parsePerformerList;
