/**
 * 涨停板全景看板 - 数据采集与HTML生成
 *
 * 功能：
 * 1. 获取每日涨停板股票，按1-2-3-4-5+连板分层
 * 2. 统计3日内连板最多的板块/概念
 * 3. 列出3日内资金流入最多的板块/概念
 * 4. 资金流入最多板块/概念中活跃TOP5个股
 * 5. 7维度涨停板强度评价体系
 *
 * 数据源：腾讯自选股（westock-data / westock-tool CLI）
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ============ 配置 ============
const WESTOCK_DATA = 'C:/Users/Administrator/.workbuddy/plugins/marketplaces/experts/plugins/stock-partner-team/skills/westock-data/scripts/index.js';
const WESTOCK_TOOL = 'C:/Users/Administrator/.workbuddy/plugins/marketplaces/experts/plugins/stock-partner-team/skills/westock-tool/scripts/index.js';
const OUTPUT_DIR = path.resolve(__dirname);
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'index.html');
const DATA_FILE = path.join(OUTPUT_DIR, 'data.json');
const TDX_CONCEPTS_FILE = path.join(OUTPUT_DIR, 'tdx_concepts_local.json');
const TDX_CONCEPT_STOCKS_FILE = path.join(OUTPUT_DIR, 'tdx_concept_stocks.json');

// 通达信概念数据缓存
let tdxConceptMap = {};
let tdxStockConcepts = {};

/**
 * 加载通达信本地概念数据并构建股票->概念反向索引
 */
function loadTdxConceptData() {
  try {
    const concepts = JSON.parse(fs.readFileSync(TDX_CONCEPTS_FILE, 'utf-8'));
    const conceptStocks = JSON.parse(fs.readFileSync(TDX_CONCEPT_STOCKS_FILE, 'utf-8'));
    tdxConceptMap = concepts.concepts || {};
    const reverse = {};
    for (const [conceptCode, stocks] of Object.entries(conceptStocks.concept_stocks || {})) {
      const conceptName = tdxConceptMap[conceptCode] || conceptCode;
      for (const stock of stocks) {
        if (!reverse[stock]) reverse[stock] = [];
        reverse[stock].push(conceptName);
      }
    }
    tdxStockConcepts = reverse;
    console.log(`📚 通达信概念数据加载完成: ${Object.keys(tdxConceptMap).length} 个概念, ${Object.keys(tdxStockConcepts).length} 只股票`);
  } catch (e) {
    console.error('⚠️ 加载通达信概念数据失败:', e.message);
  }
}

// 涨停阈值配置（考虑浮动精度）
const LIMIT_UP_THRESHOLD = {
  main: 9.8,      // 主板10%涨停
  star: 19.8,     // 科创板20%涨停
  be: 29.8,       // 北交所30%涨停
  st: 4.8,        // ST股5%涨停
};

// ============ 工具函数 ============

/**
 * 执行CLI命令并返回stdout
 */
function runCli(cmd, timeout = 30000) {
  try {
    const result = execSync(cmd, {
      encoding: 'utf-8',
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return result.trim();
  } catch (e) {
    console.error(`CLI Error: ${cmd}\n${e.message}`);
    return '';
  }
}

/**
 * 解析Markdown表格为对象数组
 */
function parseMdTable(md) {
  if (!md) return [];
  const lines = md.split('\n').filter(l => l.trim().startsWith('|') && !l.includes('---'));
  if (lines.length < 1) return [];
  const headers = lines[0].split('|').map(h => h.trim()).filter(Boolean);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length === headers.length) {
      const obj = {};
      headers.forEach((h, idx) => obj[h] = cells[idx]);
      rows.push(obj);
    }
  }
  return rows;
}

/**
 * 批量执行命令（分批处理避免超时）
 */
function batchRun(cmdFn, items, batchSize = 20) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const cmd = cmdFn(batch);
    const output = runCli(cmd, 60000);
    const parsed = parseMdTable(output);
    results.push(...parsed);
  }
  return results;
}

/**
 * 判断涨跌幅限制比例
 * 主板(60/00): 10% | 创业板(300/301): 20% | 科创板(688): 20% | 北交所(8/4): 30% | ST: 5%
 * 注意：需传入 name 用于识别 ST 股
 */
function getLimitPct(code, name = '') {
  // ST/*ST 股：5% 涨跌幅
  if (name && (name.includes('ST') || name.includes('*ST'))) return 0.05;
  if (code.startsWith('sh688') || code.startsWith('sz300') || code.startsWith('sz301')) return 0.20;
  if (code.startsWith('bj')) return 0.30;
  return 0.10;
}

/**
 * 根据前一收盘价计算涨停价（精确到分）
 * 规则：prev_close * (1 + limit_pct)，四舍五入到 2 位小数
 */
function calcLimitUpPrice(prevClose, limitPct) {
  return Math.round(prevClose * (1 + limitPct) * 100) / 100;
}

/**
 * 精确判断是否涨停：基于 prev_close 计算涨停价，price >= 涨停价
 * @param {string} code - 股票代码
 * @param {number} price - 当前价格
 * @param {number} prevClose - 前一收盘价
 * @param {string} name - 股票名称（用于识别ST）
 * @returns {boolean} 是否真正涨停
 */
function verifyLimitUp(code, price, prevClose, name = '') {
  if (!prevClose || prevClose <= 0 || !price || price <= 0) return false;

  // 排除新股/次新股首日（N/C 前缀 或 涨幅超 44%）
  const changePct = ((price - prevClose) / prevClose) * 100;
  if (name.startsWith('N') || name.startsWith('C')) return false;
  if (changePct > 44) return false; // 新股首日无涨跌幅限制

  const limitPct = getLimitPct(code, name);
  const limitUpPrice = calcLimitUpPrice(prevClose, limitPct);

  // 允许 1 分钱误差（四舍五入差异）
  return price >= limitUpPrice - 0.01;
}

/**
 * 格式化数字
 */
function fmtNum(n, decimals = 2) {
  if (n === null || n === undefined || isNaN(n)) return '-';
  if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(decimals) + '亿';
  if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(decimals) + '万';
  return parseFloat(n).toFixed(decimals);
}

/**
 * 安全解析浮点数
 */
function safeFloat(v, defaultVal = 0) {
  const n = parseFloat(v);
  return isNaN(n) ? defaultVal : n;
}

// ============ 数据采集 ============

/**
 * 获取市场涨跌分布（涨停/跌停数量）
 */
function fetchMarketDist() {
  console.log('📊 获取市场涨跌分布...');
  const output = runCli(`node "${WESTOCK_DATA}" changedist hs`, 15000);
  const tables = output.split('\n\n').filter(t => t.includes('|'));
  const summary = parseMdTable(tables[0] || '');
  const dist = parseMdTable(tables[1] || '');
  return { summary: summary[0] || {}, distribution: dist };
}

/**
 * 获取涨停板候选股票列表（宽网捕获，后续由 verifyLimitUp 精确过滤）
 *
 * 策略：
 * - 主板候选: ChangePCT >= 9.5%（含可能涨停但涨幅因四舍五入偏低的）
 * - 创业板/科创板候选: ChangePCT >= 19.5%
 * - ST 候选: ChangePCT >= 4.5%（5%涨停的ST股）
 * - 北交所候选: ChangePCT >= 29.5%（30%涨停）
 * 所有候选在 analyzeData 中通过 prev_close 精确验证
 */
function fetchLimitUpStocks() {
  console.log('📈 获取涨停板候选股票（宽网）...');

  // 主板候选（含部分创业板/科创板高涨幅股）
  const mainResult = runCli(
    `node "${WESTOCK_TOOL}" filter "intersect([ChangePCT >= 9.5, ClosePrice > 0])" --limit 300 --orderby ChangePCT:desc`,
    30000
  );
  // 创业板/科创板候选
  const starResult = runCli(
    `node "${WESTOCK_TOOL}" filter "ChangePCT >= 19.5" --limit 150 --orderby ChangePCT:desc`,
    30000
  );
  // ST 股候选（4.5%~6%，ST涨停5%）
  const stResult = runCli(
    `node "${WESTOCK_TOOL}" filter "intersect([ChangePCT >= 4.5, ChangePCT <= 6])" --limit 100 --orderby ChangePCT:desc`,
    30000
  );
  // 北交所候选
  const beResult = runCli(
    `node "${WESTOCK_TOOL}" filter "ChangePCT >= 29.5" --limit 50 --orderby ChangePCT:desc`,
    30000
  );

  const mainStocks = parseMdTable(mainResult);
  const starStocks = parseMdTable(starResult);
  const stStocks = parseMdTable(stResult);
  const beStocks = parseMdTable(beResult);

  // 去重合并
  const seen = new Set();
  const all = [];
  for (const s of [...mainStocks, ...starStocks, ...stStocks, ...beStocks]) {
    if (!seen.has(s.code)) {
      seen.add(s.code);
      all.push(s);
    }
  }
  console.log(`  候选股票共 ${all.length} 只（含ST/北交所），待精确验证`);
  return all;
}

/**
 * 批量获取股票行情详情
 */
function fetchQuotes(codes) {
  if (!codes.length) return [];
  console.log(`💹 获取${codes.length}只股票行情...`);
  return batchRun(
    batch => `node "${WESTOCK_DATA}" quote ${batch.join(',')}`,
    codes,
    15
  );
}

/**
 * 批量获取公司简况（含行业分类）
 */
function fetchProfiles(codes) {
  if (!codes.length) return [];
  console.log(`🏢 获取${codes.length}只股票简况...`);
  return batchRun(
    batch => `node "${WESTOCK_DATA}" profile ${batch.join(',')}`,
    codes,
    15
  );
}

/**
 * 批量获取资金流向
 */
function fetchCapitalFlow(codes) {
  if (!codes.length) return [];
  console.log(`💰 获取${codes.length}只股票资金流向...`);
  return batchRun(
    batch => `node "${WESTOCK_DATA}" asfund ${batch.join(',')}`,
    codes,
    15
  );
}

/**
 * 批量获取K线（支持日/周/月周期）
 * @param {string[]} codes - 股票代码列表
 * @param {number} limit - K线数量
 * @param {string} period - 周期: day|week|month
 */
function fetchKlines(codes, limit = 8, period = 'day') {
  if (!codes.length) return {};
  console.log(`📉 获取${codes.length}只股票${period}K线...`);
  const result = {};

  for (let i = 0; i < codes.length; i += 8) {
    const batch = codes.slice(i, i + 8);
    const output = runCli(
      `node "${WESTOCK_DATA}" kline ${batch.join(',')} --period ${period} --limit ${limit}`,
      45000
    );
    const rows = parseMdTable(output);
    for (const row of rows) {
      const code = row.symbol || row.code || '';
      if (!code) continue;
      if (!result[code]) result[code] = [];
      result[code].push(row);
    }
  }
  return result;
}

/**
 * 获取热门板块
 */
function fetchHotBoards() {
  console.log('🔥 获取热门板块...');
  const output = runCli(`node "${WESTOCK_DATA}" hot board --limit 30`, 15000);
  return parseMdTable(output);
}

/**
 * 获取推荐概念板块（热门概念 + 每概念3只代表股）
 * 同时产出 A(严格版) + B(放宽版)
 * 严格版：3天换手>20%、5日/5周线±3%、量比>1.2
 * 放宽版：3天换手>12%、5日/5周线±5%、无量比要求
 */
function fetchRecommendedConcepts() {
  console.log('💡 获取推荐概念板块 AB对比版...');
  const hotBoards = fetchHotBoards();

  const strictConcepts = [];
  const looseConcepts = [];
  const strictCodes = new Set(); // 严格版已选股票，用于备选版去重

  for (const board of hotBoards.slice(0, 12)) {
    const code = board.symbol || board.code || board.板块代码 || board['板块代码'];
    const name = board.name || board.板块名称 || board.名称 || board['板块名称'];
    if (!code || !name) continue;

    // 如果两套都已满6个板块，提前结束
    if (strictConcepts.length >= 6 && looseConcepts.length >= 6) break;

    // 1. 获取板块成份股（上限100只控制性能）
    let constituents = fetchSectorConstituents(code);
    if (constituents.length > 100) {
      console.log(`  ${name}: 成份股${constituents.length}只，截取前100只`);
      constituents = constituents.slice(0, 100);
    }
    const candidateCodes = constituents.map(c =>
      c.code || c.代码 || c['股票代码']
    ).filter(Boolean);
    if (candidateCodes.length === 0) continue;

    // 2. 查quote获取名称、现价、当日涨幅、10日涨幅
    const recQuotes = fetchQuotes(candidateCodes);
    const quoteMap = {};
    for (const q of recQuotes) {
      if (q.code) {
        quoteMap[q.code] = {
          name: q.name || '',
          price: safeFloat(q.price),
          changePct: safeFloat(q.change_percent),
          chg10d: safeFloat(q.chg_10d),
        };
      }
    }

    // 3. 按10日涨幅排序取前50，排除ST和当日涨幅>40%
    const top50 = candidateCodes
      .filter(c => {
        const q = quoteMap[c];
        if (!q) return false;
        const n = q.name;
        if (n.includes('ST') || n.includes('*ST')) return false;
        if (q.changePct > 40) return false;
        return true;
      })
      .sort((a, b) => (quoteMap[b]?.chg10d || 0) - (quoteMap[a]?.chg10d || 0))
      .slice(0, 50);

    if (top50.length === 0) {
      console.log(`  ${name}: 无有效候选股`);
      continue;
    }

    // 4. 查6日kline（算3天换手 + 5日均线）
    const dayKlines = fetchKlines(top50, 6, 'day');
    // 5. 查22周kline（算5/10/20周均线 + 周线多头判断）
    const weekKlines = fetchKlines(top50, 22, 'week');

    // 6. 预计算所有指标
    const computed = [];
    for (const c of top50) {
      const q = quoteMap[c];
      const dk = dayKlines[c] || [];
      const wk = weekKlines[c] || [];
      if (!q || dk.length < 5 || wk.length < 20) continue;

      const turnover3d = dk.slice(0, 3).reduce((sum, d) => sum + safeFloat(d.exchange), 0);
      const ma5  = dk.slice(0, 5).reduce((sum, d) => sum + safeFloat(d.last), 0) / 5;
      const ma5w  = wk.slice(0, 5).reduce((sum, d) => sum + safeFloat(d.last), 0) / 5;
      const ma10w = wk.slice(0, 10).reduce((sum, d) => sum + safeFloat(d.last), 0) / 10;
      const ma20w = wk.slice(0, 20).reduce((sum, d) => sum + safeFloat(d.last), 0) / 20;

      computed.push({
        code: c,
        name: q.name,
        price: q.price,
        changePct: q.changePct,
        chg10d: q.chg10d,
        turnover3d,
        ma5,
        ma5w,
        ma10w,
        ma20w,
      });
    }

    // 7. 分别用两套配置过滤
    function filterWithConfig(list, config) {
      return list.filter(s => {
        if (s.turnover3d < config.turnover3dMin) return false;
        // 严格版：收盘价在5日线±2%以内
        if (config.ma5DayTolerance !== null) {
          const lo = s.ma5 * (1 - config.ma5DayTolerance);
          const hi = s.ma5 * (1 + config.ma5DayTolerance);
          if (s.price < lo || s.price > hi) return false;
        }
        // 周线多头排列: MA5周 > MA10周 > MA20周
        if (s.ma5w <= s.ma10w || s.ma10w <= s.ma20w) return false;
        return true;
      }).sort((a, b) => b.turnover3d - a.turnover3d).slice(0, 6);
    }

    const strictResult = filterWithConfig(computed, {
      turnover3dMin: 15, ma5DayTolerance: 0.02,
    });
    const looseResult = filterWithConfig(computed, {
      turnover3dMin: 8, ma5DayTolerance: null,
    });

    const boardInfo = {
      name,
      code,
      changePct: safeFloat(board.zdf || board.changePct || board['涨跌幅'] || board['5日%'] || board['chg5Days']),
    };

    // 严格版：满6个板块后不再收集
    if (strictConcepts.length < 6 && strictResult.length > 0) {
      strictConcepts.push({ ...boardInfo, stocks: strictResult });
      strictResult.forEach(s => strictCodes.add(s.code));
    }

    // 备选版：排除严格版已有股票，满6个板块后不再收集
    const looseFiltered = looseResult.filter(s => !strictCodes.has(s.code));
    if (looseConcepts.length < 6 && looseFiltered.length > 0) {
      looseConcepts.push({ ...boardInfo, stocks: looseFiltered });
    }

    console.log(`  ${name}: ${computed.length}只候选 → 严格${strictResult.length}只 / 备选${looseFiltered.length}只(原${looseResult.length})`);
  }

  console.log(`  推荐概念板块: 严格${strictConcepts.length}个 / 备选${looseConcepts.length}个`);
  return { strict: strictConcepts, loose: looseConcepts };
}

/**
 * 获取板块区间涨幅排行
 */
function fetchSectorRankings() {
  console.log('📊 获取板块涨幅排行...');
  // 申万一级行业
  const sw1Output = runCli(
    `node "${WESTOCK_DATA}" sector --rank interval_chg_rank_sw1 --sort chg5Days`,
    20000
  );
  // 聚源产业概念
  const indyOutput = runCli(
    `node "${WESTOCK_DATA}" sector --rank interval_chg_rank_industry --sort chg5Days`,
    20000
  );

  return {
    sw1: parseMdTable(sw1Output.replace(/[^\n]*📈[^\n]*\n?/g, '').replace(/[^\n]*📊[^\n]*\n?/g, '')),
    industry: parseMdTable(indyOutput.replace(/[^\n]*📈[^\n]*\n?/g, '').replace(/[^\n]*📊[^\n]*\n?/g, '')),
  };
}

/**
 * 获取板块成份股（用于资金流向计算）
 */
function fetchSectorConstituents(sectorCode) {
  const output = runCli(`node "${WESTOCK_DATA}" sector ${sectorCode}`, 20000);
  return parseMdTable(output);
}

/**
 * 获取龙虎榜
 */
function fetchLhb() {
  console.log('🐯 获取龙虎榜...');
  const output = runCli(`node "${WESTOCK_DATA}" lhb`, 20000);
  // 解析机构榜和游资榜
  const sections = output.split(/[*]{2,}/);
  const jgTable = sections.find(s => s.includes('机构榜'));
  const yzTable = sections.find(s => s.includes('游资榜'));

  return {
    institutional: jgTable ? parseMdTable(jgTable) : [],
    hotMoney: yzTable ? parseMdTable(yzTable) : [],
  };
}

// ============ 数据分析 ============

/**
 * 综合分析：合并所有数据并计算指标
 * 关键改进：基于 prev_close 精确验证涨停，过滤新股/未封板股
 */
function analyzeData(limitUpCodes, quotes, profiles, capitalFlows, klines, sectorRankings, lhb, marketDist) {
  console.log('🔬 综合分析数据...');

  // 构建股票映射
  const stockMap = {};
  // 同时构建 quote 的 prev_close 查询表（用于精确验证）
  const prevCloseMap = {};
  const nameMap = {};

  for (const q of quotes) {
    if (q.code) {
      prevCloseMap[q.code] = safeFloat(q.prev_close);
      nameMap[q.code] = q.name || '';
    }
  }

  // ===== 精确验证涨停 =====
  // 基于 prev_close 计算涨停价，只有 price >= 涨停价 才算真正涨停
  const verifiedCodes = [];
  const rejectedReasons = [];
  for (const code of limitUpCodes) {
    const q = quotes.find(q2 => q2.code === code);
    if (!q) {
      rejectedReasons.push({ code, reason: '无行情数据' });
      continue;
    }
    const price = safeFloat(q.price);
    const prevClose = safeFloat(q.prev_close);
    const name = q.name || '';

    // 新股排除：N/C 前缀 或 涨幅超44%（首日无涨跌幅限制）
    const changePct = safeFloat(q.change_percent);
    if (name.startsWith('N') || name.startsWith('C')) {
      rejectedReasons.push({ code, name, reason: `新股(${name})首日无涨跌幅限制` });
      continue;
    }
    if (changePct > 44) {
      rejectedReasons.push({ code, name, reason: `涨幅${changePct.toFixed(1)}%超44%，疑似新股首日` });
      continue;
    }

    // 精确验证：price >= 涨停价
    if (verifyLimitUp(code, price, prevClose, name)) {
      verifiedCodes.push(code);
    } else {
      const limitPct = getLimitPct(code, name);
      const limitUpPrice = calcLimitUpPrice(prevClose, limitPct);
      rejectedReasons.push({ code, name, reason: `未封涨停(价${price} < 涨停价${limitUpPrice}, 涨幅${changePct.toFixed(2)}%)` });
    }
  }

  console.log(`  候选 ${limitUpCodes.length} 只 → 验证通过 ${verifiedCodes.length} 只，排除 ${rejectedReasons.length} 只`);
  if (rejectedReasons.length > 0) {
    // 显示前10个排除原因
    for (const r of rejectedReasons.slice(0, 10)) {
      console.log(`    ❌ ${r.code} ${r.name || ''}: ${r.reason}`);
    }
    if (rejectedReasons.length > 10) {
      console.log(`    ... 还有 ${rejectedReasons.length - 10} 只被排除`);
    }
  }

  // 用验证后的代码列表替代原始列表
  const validCodes = verifiedCodes;

  for (const code of validCodes) {
    stockMap[code] = {
      code,
      name: '',
      industry: '',
      changePct: 0,
      price: 0,
      prevClose: 0,
      volume: 0,
      amount: 0,
      turnoverRate: 0,
      volumeRatio: 0,
      mainNetFlow: 0,
      jumboNetFlow: 0,
      pe: 0,
      pb: 0,
      totalMv: 0,
      floatMv: 0,
      consecutiveLimit: 1,
      limitUpStrength: 0,
      concepts: tdxStockConcepts[code] || [],
      sealTime: '-',
      openCount: 0,
    };
  }

  // 填充行情数据
  for (const q of quotes) {
    const code = q.code;
    if (!stockMap[code]) continue;
    stockMap[code].name = q.name || '';
    stockMap[code].changePct = safeFloat(q.change_percent);
    stockMap[code].price = safeFloat(q.price);
    stockMap[code].prevClose = safeFloat(q.prev_close);
    stockMap[code].volume = safeFloat(q.volume);
    stockMap[code].amount = safeFloat(q.amount);
    stockMap[code].turnoverRate = safeFloat(q.turnover_rate);
    stockMap[code].volumeRatio = safeFloat(q.volume_ratio);
    stockMap[code].pe = safeFloat(q.pe_ratio);
    stockMap[code].pb = safeFloat(q.pb_ratio);
    stockMap[code].totalMv = safeFloat(q.total_market_cap);
    stockMap[code].floatMv = safeFloat(q.circulating_market_cap);
  }

  // 填充行业数据
  for (const p of profiles) {
    const code = p.code;
    if (!stockMap[code]) continue;
    stockMap[code].industry = p.industry || p.sector || '';
  }

  // 填充资金流向
  for (const cf of capitalFlows) {
    const code = cf.code;
    if (!stockMap[code]) continue;
    stockMap[code].mainNetFlow = safeFloat(cf.MainNetFlow);
    stockMap[code].jumboNetFlow = safeFloat(cf.JumboNetFlow);
  }

  // ===== 计算连板数（精确版：基于涨停价验证） =====
  for (const code of validCodes) {
    const kdata = klines[code];
    const name = stockMap[code].name;
    const limitPct = getLimitPct(code, name);

    if (!kdata || kdata.length < 2) {
      // 无K线数据时，至少今日涨停所以默认1板
      stockMap[code].consecutiveLimit = 1;
      continue;
    }

    // 过滤有效交易日（有成交量的），按日期从新到旧排列
    const validDays = kdata
      .filter(d => safeFloat(d.last) > 0 && safeFloat(d.volume) > 0)
      .sort((a, b) => b.date.localeCompare(a.date)); // 最新在前

    if (validDays.length < 1) {
      stockMap[code].consecutiveLimit = 1;
      continue;
    }

    let consecutive = 0;

    // 第一天（最新日/今天）：已通过 verifyLimitUp 确认涨停
    consecutive = 1;

    // 后续天：用K线收盘价与前一天收盘价计算涨停价，验证是否涨停
    // validDays[0] = 今天（最新）, validDays[1] = 昨天, validDays[2] = 前天...
    for (let i = 1; i < validDays.length; i++) {
      const dayClose = safeFloat(validDays[i].last);       // 当天收盘价
      const prevDayClose = safeFloat(validDays[i - 1].last); // 后一天收盘价（时间更近）

      // 需要用当天的前一天收盘价来计算涨停价
      // validDays[i] 的前一天是 validDays[i+1]
      const dayBeforeClose = i + 1 < validDays.length ? safeFloat(validDays[i + 1].last) : 0;

      if (dayBeforeClose <= 0) break;

      // 计算当天涨停价
      const dayLimitUpPrice = calcLimitUpPrice(dayBeforeClose, limitPct);

      // 判断当天是否涨停：收盘价 >= 涨停价（允许1分钱误差）
      if (dayClose >= dayLimitUpPrice - 0.01) {
        consecutive++;
      } else {
        break;
      }
    }

    stockMap[code].consecutiveLimit = Math.max(consecutive, 1);
  }

  // 龙虎榜标记
  const lhbCodes = new Set();
  if (lhb.institutional) {
    for (const item of lhb.institutional) {
      if (item.code) lhbCodes.add(item.code);
    }
  }
  if (lhb.hotMoney) {
    for (const item of lhb.hotMoney) {
      if (item.code) lhbCodes.add(item.code);
    }
  }

  // ========== 聚合分析 ==========

  // 按连板数分层
  const ladderMap = {};
  for (const code of validCodes) {
    const level = Math.min(stockMap[code].consecutiveLimit, 7);
    const key = level >= 5 ? '5+' : String(level);
    if (!ladderMap[key]) ladderMap[key] = [];
    ladderMap[key].push(stockMap[code]);
  }

  // 按行业聚合
  const industryMap = {};
  for (const code of validCodes) {
    const ind = stockMap[code].industry || '其他';
    if (!industryMap[ind]) industryMap[ind] = { count: 0, codes: [], mainNetFlow: 0 };
    industryMap[ind].count++;
    industryMap[ind].codes.push(code);
    industryMap[ind].mainNetFlow += stockMap[code].mainNetFlow;
  }

  // 行业热度排行（涨停家数+资金流入）
  const industryHeat = Object.entries(industryMap)
    .map(([name, data]) => ({
      name,
      limitCount: data.count,
      mainNetFlow: data.mainNetFlow,
      codes: data.codes,
    }))
    .sort((a, b) => b.limitCount - a.limitCount || b.mainNetFlow - a.mainNetFlow);

  // 资金流入排行
  const industryFlowRank = Object.entries(industryMap)
    .map(([name, data]) => ({
      name,
      mainNetFlow: data.mainNetFlow,
      limitCount: data.count,
    }))
    .sort((a, b) => b.mainNetFlow - a.mainNetFlow);

  // ========== 强度评分 ==========
  for (const code of validCodes) {
    const s = stockMap[code];
    let score = 0;

    // 1. 连板加分 (0-30)
    score += Math.min(s.consecutiveLimit, 5) * 6;

    // 2. 换手率加分 (0-15): 3-15%最佳
    const tr = s.turnoverRate;
    if (tr >= 3 && tr <= 15) score += 15;
    else if (tr >= 1 && tr < 3) score += 8;
    else if (tr > 15 && tr <= 30) score += 10;
    else if (tr > 30) score += 5;
    else score += 3;

    // 3. 量比加分 (0-15)
    const vr = s.volumeRatio;
    if (vr >= 2 && vr <= 5) score += 15;
    else if (vr >= 1.5 && vr < 2) score += 10;
    else if (vr > 5) score += 8;
    else score += 5;

    // 4. 主力净流入加分 (0-20)
    if (s.mainNetFlow > 0) {
      const flowScore = Math.min(s.mainNetFlow / s.floatMv * 100 * 5, 20);
      score += Math.max(flowScore, 5);
    } else {
      score += 2;
    }

    // 5. 龙虎榜加分 (0-10)
    if (lhbCodes.has(code)) score += 10;

    // 6. 板块效应加分 (0-10)
    const indCount = industryMap[s.industry]?.count || 1;
    if (indCount >= 5) score += 10;
    else if (indCount >= 3) score += 7;
    else if (indCount >= 2) score += 4;
    else score += 1;

    s.limitUpStrength = Math.round(Math.min(score, 100));
  }

  // 板块/概念活跃个股TOP5
  const activeStocksByIndustry = {};
  for (const ind of industryHeat.slice(0, 10)) {
    const stocksInInd = ind.codes
      .map(c => stockMap[c])
      .sort((a, b) => b.limitUpStrength - a.limitUpStrength);
    activeStocksByIndustry[ind.name] = stocksInInd.slice(0, 5);
  }

  // 通达信概念热度（基于本地概念映射）
  const conceptHeatMap = {};
  for (const code of validCodes) {
    const concepts = stockMap[code].concepts;
    for (const c of concepts) {
      if (!conceptHeatMap[c]) conceptHeatMap[c] = { count: 0, totalStrength: 0, codes: [] };
      conceptHeatMap[c].count++;
      conceptHeatMap[c].totalStrength += stockMap[code].limitUpStrength;
      conceptHeatMap[c].codes.push(code);
    }
  }
  const conceptHeat = Object.entries(conceptHeatMap)
    .map(([name, data]) => ({
      name,
      limitCount: data.count,
      avgStrength: data.count > 0 ? Math.round(data.totalStrength / data.count) : 0,
      totalStrength: data.totalStrength,
      codes: data.codes,
    }))
    .sort((a, b) => b.limitCount - a.limitCount || b.totalStrength - a.totalStrength);

  return {
    stockMap,
    ladderMap,
    industryHeat,
    industryFlowRank,
    activeStocksByIndustry,
    marketDist,
    sectorRankings,
    lhbCodes: [...lhbCodes],
    conceptHeat,
    generatedAt: new Date().toISOString(),
    tradingDate: quotes[0]?.time?.split(' ')[0] || new Date().toISOString().split('T')[0],
  };
}

// ============ HTML生成 ============

function generateHTML(data) {
  const { stockMap, ladderMap, industryHeat, industryFlowRank, activeStocksByIndustry, marketDist, sectorRankings, lhbCodes, generatedAt, tradingDate, recommendedConcepts, recommendedConceptsLoose, conceptHeat } = data;

  const totalLimitUp = Object.keys(stockMap).length;
  const limitDown = marketDist.summary?.跌停 || '-';
  const totalUp = marketDist.summary?.上涨 || '-';
  const totalDown = marketDist.summary?.下跌 || '-';
  const ladderLevels = ['1', '2', '3', '4', '5+'];
  const ladderCounts = ladderLevels.map(l => ladderMap[l]?.length || 0);
  const industryFlowTop = industryFlowRank.slice(0, 5);
  const industryHeatTop = industryHeat.slice(0, 5);
  const conceptTop = sectorRankings.industry?.slice(0, 20) || [];

  function strengthBadge(score) {
    if (score >= 80) return '<span class="badge badge-s">S</span>';
    if (score >= 60) return '<span class="badge badge-a">A</span>';
    if (score >= 40) return '<span class="badge badge-b">B</span>';
    return '<span class="badge badge-c">C</span>';
  }

  function fc(n) { return fmtNum(n); }
  function pct(v) { return safeFloat(v).toFixed(2); }
  function pctClass(v) { return safeFloat(v) >= 0 ? 'up' : 'dn'; }
  function flowClass(v) { return v >= 0 ? 'up' : 'dn'; }
  function stockLink(code) {
    // 同花顺个股页面: 去掉 sh/sz/bj 前缀，保留纯数字代码
    const pureCode = code.replace(/^(sh|sz|bj)/, '');
    return `https://stockpage.10jqka.com.cn/${pureCode}/`;
  }

  // 连板核心表 - 合并所有层级，用颜色区分
  const allStocksSorted = Object.values(stockMap)
    .sort((a, b) => b.consecutiveLimit - a.consecutiveLimit || b.limitUpStrength - a.limitUpStrength);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>涨停板全景看板 ${tradingDate}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#f5f5f7;--card:#fff;--bdr:#e5e5e5;
  --t1:#1d1d1f;--t2:#6e6e73;--t3:#aeaeb2;
  --up:#cf1322;--dn:#389e0d;
  --bg-up:#fff1f0;--bg-dn:#f6ffed;
  --blue:#1677ff;--orange:#d46b08;--purple:#531dab;--gold:#d48806;
}
html{font-size:16px;-webkit-font-smoothing:antialiased}
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--t1);line-height:1.4}
.wrap{max-width:1480px;margin:0 auto;padding:10px 14px}

/* === 头部 === */
.hdr{background:linear-gradient(135deg,#1d1d1f 0%,#2c2c2e 100%);color:#fff;border-radius:10px;padding:14px 20px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px}
.hdr h1{font-size:24px;font-weight:800;letter-spacing:2px}
.hdr .meta{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.hdr .tag{background:rgba(255,255,255,.1);padding:5px 14px;border-radius:6px;font-size:15px;font-weight:600}
.t-up{color:#ff7875!important}.t-dn{color:#95de64!important}.t-gd{color:#ffd666!important}

/* === 连板快照 === */
.snap{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin:10px 0}
.snap-i{background:var(--card);border-radius:8px;padding:10px 8px;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,.06);border:1px solid var(--bdr);cursor:pointer;transition:all .15s}
.snap-i:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(0,0,0,.1)}
.snap-i .lbl{font-size:15px;color:var(--t2);font-weight:500}
.snap-i .num{font-size:36px;font-weight:900;color:var(--up);line-height:1.1}
.snap-i .unit{font-size:13px;color:var(--t3)}
.snap-i.lv5 .num{color:var(--gold)}
.snap-i.lv4 .num{color:var(--purple)}
.snap-i.lv3 .num{color:var(--up)}
.snap-i.lv2 .num{color:var(--orange)}

/* === 卡片 === */
.cd{background:var(--card);border-radius:8px;box-shadow:0 1px 2px rgba(0,0,0,.06);border:1px solid var(--bdr);margin-bottom:10px;overflow:hidden}
.cd-h{padding:10px 16px;font-size:18px;font-weight:700;border-bottom:1px solid var(--bdr);display:flex;align-items:center;gap:8px;background:#fafafa}
.cd-h .ico{font-size:20px}
.cd-h .sub{margin-left:auto;font-size:13px;color:var(--t3);font-weight:400}

/* === 表格 === */
.tb{width:100%;border-collapse:collapse;font-size:15px}
.tb th{background:#f0f0f2;padding:8px 10px;text-align:left;font-weight:600;font-size:14px;color:var(--t2);white-space:nowrap;position:sticky;top:0;z-index:2}
.tb td{padding:7px 10px;border-bottom:1px solid #f0f0f0;white-space:nowrap;font-size:15px}
.tb tr:hover td{background:#f8f8fa}
.tb .c{color:var(--blue);font-family:Consolas,monospace;font-size:14px}
.tb .up{color:var(--up);font-weight:700}
.tb .dn{color:var(--dn);font-weight:700}
.tb .b{font-weight:700}
.tb .m{color:var(--t3);font-size:13px}

/* 强度徽章 */
.badge{display:inline-block;padding:2px 10px;border-radius:4px;font-weight:800;font-size:14px;letter-spacing:1px}
.badge-s{background:linear-gradient(135deg,#ff4d4f,#cf1322);color:#fff}
.badge-a{background:linear-gradient(135deg,#ff7a45,#d46b08);color:#fff}
.badge-b{background:linear-gradient(135deg,#8c8c8c,#595959);color:#fff}
.badge-c{background:#f0f0f0;color:#8c8c8c}

/* 连板色条 */
.bar{display:inline-block;width:4px;height:20px;border-radius:2px;margin-right:6px;vertical-align:middle}
.bar-1{background:#d9d9d9}.bar-2{background:#ff7a45}.bar-3{background:#cf1322}.bar-4{background:#531dab}.bar-5{background:#d48806}

/* 行业标签 */
.tag-i{display:inline-block;padding:2px 10px;border-radius:4px;font-size:14px;background:#e6f7ff;color:var(--blue);font-weight:500}
.stock-link{color:var(--t1);text-decoration:none;border-bottom:1px dashed var(--blue);cursor:pointer}
.stock-link:hover{color:var(--blue);border-bottom-style:solid}

/* Tab */
.tabs{display:flex;gap:0;border-bottom:2px solid var(--bdr);background:#fafafa}
.tab{padding:9px 18px;cursor:pointer;font-size:16px;font-weight:600;color:var(--t2);border-bottom:3px solid transparent;margin-bottom:-2px;transition:all .15s}
.tab:hover{color:var(--t1)}
.tab.on{color:var(--up);border-bottom-color:var(--up)}
.tpanel{display:none}.tpanel.on{display:block}

/* 双列 */
.g2{display:grid;grid-template-columns:1fr 1fr;gap:10px}

/* 滚动 */
.scr{max-height:560px;overflow-y:auto}
.scr::-webkit-scrollbar{width:5px}
.scr::-webkit-scrollbar-thumb{background:#d9d9d9;border-radius:3px}

/* 页脚 */
.ftr{text-align:center;padding:14px;font-size:13px;color:var(--t3)}
.ftr .warn{background:#fffbe6;color:#d48806;padding:8px 16px;border-radius:6px;margin-bottom:6px;font-size:13px;font-weight:500}

/* 活跃个股 */
.act-item{padding:8px 14px;border-bottom:1px solid #f5f5f5}
.act-item:last-child{border-bottom:none}
.act-row{display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:15px}

/* 连板王卡片 */
.king{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;padding:12px}
.king-c{background:#fafafa;border-radius:8px;padding:10px 14px;border-left:4px solid var(--up)}
.king-c .kn{font-size:18px;font-weight:800}.king-c .km{font-size:13px;color:var(--t2);margin-top:2px}
.king-c.lv5{border-left-color:var(--gold);background:#fffbe6}
.king-c.lv4{border-left-color:var(--purple);background:#f9f0ff}
.king-c.lv3{border-left-color:var(--up);background:#fff1f0}
.king-c.lv2{border-left-color:var(--orange);background:#fff7e6}

@media(max-width:900px){.g2{grid-template-columns:1fr}.snap{grid-template-columns:repeat(3,1fr)}}
</style>
</head>
<body>
<div class="wrap">

<!-- 头部 -->
<div class="hdr">
  <h1>📊 涨停板全景看板</h1>
  <div class="meta">
    <span class="tag">📅 ${tradingDate}</span>
    <span class="tag t-up">涨停 ${totalLimitUp}</span>
    <span class="tag t-dn">跌停 ${limitDown}</span>
    <span class="tag">上涨 ${totalUp}</span>
    <span class="tag">下跌 ${totalDown}</span>
    <span class="tag t-gd">🔄 ${generatedAt.replace('T',' ').slice(11,16)}</span>
  </div>
</div>

<!-- 推荐概念板块 -->
${(() => {
  const renderConcepts = (list, label, color) => `
    <div class="cd" style="margin-bottom:10px">
      <div class="cd-h"><span class="ico">💡</span>${label}</div>
      <div class="snap" style="grid-template-columns:repeat(3,1fr);padding:0 12px 12px">
        ${list.map(c => `
          <div class="snap-i" style="text-align:left;padding:12px 14px;cursor:default">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
              <span style="font-size:15px;font-weight:700;color:var(--t1)">${c.name}</span>
              <span class="up" style="font-size:15px;font-weight:700">${pct(c.changePct)}%</span>
            </div>
            <div style="display:flex;flex-direction:column;gap:4px">
              ${c.stocks.map(s => {
                const d5 = s.ma5 > 0 ? ((s.price - s.ma5) / s.ma5 * 100).toFixed(2) : '0.00';
                const w5 = s.ma5w > 0 ? ((s.price - s.ma5w) / s.ma5w * 100).toFixed(2) : '0.00';
                return `<div style="display:flex;justify-content:space-between;align-items:center;font-size:14px">
                  <a class="stock-link" href="${stockLink(s.code)}" target="_blank" style="color:var(--t1);font-weight:600">${s.name}</a>
                  <span class="${pctClass(s.changePct)}">${pct(s.changePct)}%</span>
                </div>
                <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--t3);margin-bottom:4px;padding-left:4px;border-left:2px solid var(--bdr)">
                  <span class="c">${s.code}</span>
                  <span>
                    <span style="margin-right:8px">10日<span class="${pctClass(s.chg10d)}">${pct(s.chg10d)}%</span></span>
                    <span style="margin-right:8px">3日换手<span style="color:var(--purple);font-weight:600">${pct(s.turnover3d)}%</span></span>
                    <span style="margin-right:8px">5日<span class="${pctClass(d5)}">${d5}%</span></span>
                    <span style="margin-right:8px">5周<span class="${pctClass(w5)}">${w5}%</span></span>
                    <span style="color:var(--dn);font-weight:600">周线多头</span>
                  </span>
                </div>`;
              }).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
  return ((recommendedConcepts || []).length > 0 ? renderConcepts(recommendedConcepts, '推荐概念板块', '#cf1322') : '')
       + ((recommendedConceptsLoose || []).length > 0 ? renderConcepts(recommendedConceptsLoose, '备选概念板块', '#d46b08') : '');
})()}

<!-- 连板王 -->
${(ladderMap['5+'] || []).length > 0 || (ladderMap['4'] || []).length > 0 || (ladderMap['3'] || []).length > 0 ? `
<div class="cd">
  <div class="cd-h"><span class="ico">👑</span>连板王<span class="sub">3板及以上</span></div>
  <div class="king">
    ${[...(ladderMap['5+'] || []), ...(ladderMap['4'] || []), ...(ladderMap['3'] || [])]
      .sort((a,b) => b.consecutiveLimit - a.consecutiveLimit || b.limitUpStrength - a.limitUpStrength)
      .map(s => {
        const lv = s.consecutiveLimit >= 5 ? 'lv5' : s.consecutiveLimit === 4 ? 'lv4' : 'lv3';
        return `<div class="king-c ${lv}">
          <div class="kn"><a class="stock-link" href="${stockLink(s.code)}" target="_blank">${s.name}</a> <span class="up">${s.consecutiveLimit}连板</span></div>
          <div class="km">${s.code} · ${s.industry} · ${pct(s.changePct)}% · 换手${pct(s.turnoverRate)}% ${strengthBadge(s.limitUpStrength)}${s.limitUpStrength}</div>
        </div>`;
      }).join('')}
  </div>
</div>` : ''}

<!-- 双列：行业热度 + 资金流向 -->
<div class="g2">

<div class="cd">
  <div class="cd-h"><span class="ico">🏭</span>行业涨停热度<span class="sub">按涨停家数排序</span></div>
  <div class="scr" style="max-height:420px">
    <table class="tb">
      <thead><tr><th>#</th><th>行业</th><th>涨停家数</th><th>主力净流入</th><th>代表个股</th></tr></thead>
      <tbody>
        ${industryHeatTop.map((ind, idx) => {
          const ts = (activeStocksByIndustry[ind.name]||[]).slice(0,3);
          return `<tr>
            <td>${idx+1}</td>
            <td class="b">${ind.name}</td>
            <td class="up b" style="font-size:18px">${ind.limitCount}</td>
            <td class="${flowClass(ind.mainNetFlow)}">${fc(ind.mainNetFlow)}</td>
            <td class="m">${ts.map(s=>`<a class="stock-link" href="${stockLink(s.code)}" target="_blank">${s.name}</a>`).join('、')}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>
</div>

<div class="cd">
  <div class="cd-h"><span class="ico">💰</span>行业资金流向<span class="sub">按主力净流入排序</span></div>
  <div class="scr" style="max-height:420px">
    <table class="tb">
      <thead><tr><th>#</th><th>行业</th><th>主力净流入</th><th>涨停</th><th>代表个股</th></tr></thead>
      <tbody>
        ${industryFlowTop.map((ind, idx) => {
          const ts = (activeStocksByIndustry[ind.name]||[]).slice(0,3);
          return `<tr>
            <td>${idx+1}</td>
            <td class="b">${ind.name}</td>
            <td class="${flowClass(ind.mainNetFlow)} b" style="font-size:16px">${fc(ind.mainNetFlow)}</td>
            <td class="up">${ind.limitCount}</td>
            <td class="m">${ts.map(s=>`<a class="stock-link" href="${stockLink(s.code)}" target="_blank">${s.name}</a>`).join('、')}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>
</div>

</div>

<!-- 双列：概念 + 活跃个股 -->
<div class="g2">

<div class="cd">
  <div class="cd-h"><span class="ico">🔥</span>通达信概念涨停热度<span class="sub">按涨停家数排序</span></div>
  <div class="scr" style="max-height:420px">
    <table class="tb">
      <thead><tr><th>#</th><th>概念</th><th>涨停家数</th><th>平均强度</th></tr></thead>
      <tbody>
        ${(conceptHeat || []).slice(0,30).map((c, idx) => `<tr>
          <td>${idx+1}</td>
          <td class="b">${c.name}</td>
          <td class="up b" style="font-size:18px">${c.limitCount}</td>
          <td>${strengthBadge(c.avgStrength)} <span class="m">${c.avgStrength}</span></td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
</div>

<div class="cd">
  <div class="cd-h"><span class="ico">⭐</span>行业活跃个股 TOP5<span class="sub">按强度评分</span></div>
  <div class="scr" style="max-height:420px">
    ${industryHeatTop.slice(0,10).map(ind => {
      const stocks = activeStocksByIndustry[ind.name]||[];
      if (!stocks.length) return '';
      return `<div class="act-item">
        <div style="font-weight:700;font-size:16px;margin-bottom:4px">
          <span class="tag-i">${ind.name}</span>
          <span class="up" style="font-size:14px">${ind.limitCount}只涨停</span>
        </div>
        ${stocks.map(s => `<div class="act-row">
          <a class="stock-link b" href="${stockLink(s.code)}" target="_blank">${s.name}</a>
          <span>
            <span class="up">${pct(s.changePct)}%</span>
            ${strengthBadge(s.limitUpStrength)}
            ${s.consecutiveLimit>1?`<span style="background:#fff7e6;color:#d46b08;padding:2px 8px;border-radius:3px;font-size:13px;font-weight:700">${s.consecutiveLimit}连板</span>`:''}
          </span>
        </div>`).join('')}
      </div>`;
    }).join('')}
  </div>
</div>

</div>

<!-- 涨停详表 -->
<div class="cd">
  <div class="cd-h"><span class="ico">🔥</span>涨停板全景<span class="sub">共 ${totalLimitUp} 只 · 按连板+强度排序</span></div>
  <div>
    <div class="tabs" id="lt">
      ${ladderLevels.map((l, i) => `<div class="tab ${i===0?'on':''}" data-v="${l}" onclick="sw('${l}')">${l==='5+'?'5板+':l+'板'}(${ladderCounts[i]})</div>`).join('')}
    </div>
    ${ladderLevels.map((l, i) => {
      const stocks = (ladderMap[l] || []).sort((a,b) => b.limitUpStrength - a.limitUpStrength);
      return `<div class="tpanel ${i===0?'on':''}" id="p-${l}">
        <div class="scr">
          <table class="tb">
            <thead><tr>
              <th>#</th><th>连板</th><th>代码</th><th>名称</th><th>行业</th>
              <th>涨跌幅</th><th>现价</th><th>换手率</th><th>量比</th>
              <th>主力净流入</th><th>超大单</th><th>流通市值</th><th>PE</th><th>强度</th>
            </tr></thead>
            <tbody>
              ${stocks.map((s, idx) => {
                const barCls = Math.min(s.consecutiveLimit, 5);
                return `<tr>
                  <td>${idx+1}</td>
                  <td><span class="bar bar-${barCls}"></span><b>${s.consecutiveLimit}</b></td>
                  <td class="c"><a class="stock-link" href="${stockLink(s.code)}" target="_blank">${s.code}</a></td>
                  <td class="b">
                    <a class="stock-link" href="${stockLink(s.code)}" target="_blank">${s.name}</a>
                    ${s.concepts && s.concepts.length ? `<div style="margin-top:3px">${s.concepts.slice(0,4).map(c => `<span class="tag-i" style="font-size:12px;padding:1px 6px">${c}</span>`).join('')}</div>` : ''}
                  </td>
                  <td><span class="tag-i">${s.industry||'-'}</span></td>
                  <td class="up">${pct(s.changePct)}%</td>
                  <td>${pct(s.price)}</td>
                  <td>${pct(s.turnoverRate)}%</td>
                  <td>${pct(s.volumeRatio)}</td>
                  <td class="${flowClass(s.mainNetFlow)}">${fc(s.mainNetFlow)}</td>
                  <td class="${flowClass(s.jumboNetFlow)}">${fc(s.jumboNetFlow)}</td>
                  <td>${fc(s.floatMv)}</td>
                  <td>${s.pe>0?pct(s.pe):'-'}</td>
                  <td>${strengthBadge(s.limitUpStrength)} <span class="m">${s.limitUpStrength}</span></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
    }).join('')}
  </div>
</div>

<!-- 强度评价体系 -->
<div class="cd">
  <div class="cd-h"><span class="ico">📐</span>涨停板强度评价体系 (7维24指标)</div>
  <div style="padding:12px 16px">
    <table class="tb">
      <thead><tr><th>维度</th><th>核心指标</th><th>权重</th><th>说明</th></tr></thead>
      <tbody>
        <tr><td class="b">连板动能</td><td>连板天数、板间换手、加速形态</td><td>30%</td><td>连板数越多持续性越强，适度换手最佳</td></tr>
        <tr><td class="b">资金共识</td><td>主力净流入、量比、龙虎榜阵容</td><td>20%</td><td>主力大额流入+机构/知名游资参与为佳</td></tr>
        <tr><td class="b">换手量能</td><td>换手率、量比</td><td>15%</td><td>3-15%换手为佳，量比2-5倍有动能</td></tr>
        <tr><td class="b">板块效应</td><td>同板块涨停数、龙头地位、概念叠加</td><td>10%</td><td>≥3家板块共振强，龙头>跟风</td></tr>
        <tr><td class="b">龙虎榜</td><td>机构买入、知名游资</td><td>10%</td><td>机构>知名游资>普通游资</td></tr>
        <tr><td class="b">市值结构</td><td>流通市值、筹码集中度</td><td>10%</td><td>小盘(≤50亿)易连板，大盘需更强动力</td></tr>
        <tr><td class="b">封板强度</td><td>封板时间、封单比、开板次数</td><td>5%</td><td>开盘涨停>早盘>午盘>尾盘，0开板最强</td></tr>
      </tbody>
    </table>
    <div style="margin-top:6px;font-size:14px;color:var(--t2)">
      评级：<span class="badge badge-s">S</span> ≥80 极强 &nbsp; <span class="badge badge-a">A</span> ≥60 强 &nbsp; <span class="badge badge-b">B</span> ≥40 中 &nbsp; <span class="badge badge-c">C</span> &lt;40 弱
    </div>
  </div>
</div>

<div class="ftr">
  <div class="warn">⚠️ 以上内容由 AI 基于公开信息整理生成，仅供参考，不构成任何投资建议或个股推荐。投资有风险，决策需谨慎。</div>
  <div>数据来源：腾讯自选股 | 生成时间：${generatedAt.replace('T',' ').slice(0,19)}</div>
</div>

</div>

<script>
function sw(v){document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));document.querySelectorAll('.tpanel').forEach(t=>t.classList.remove('on'));document.querySelector('.tab[data-v="'+v+'"]').classList.add('on');document.getElementById('p-'+v).classList.add('on')}
function go(v){sw(v);document.querySelector('.cd').scrollIntoView({behavior:'smooth'})}
</script>
</body></html>`;
}

// ============ 主流程 ============

async function main() {
  console.log('🚀 涨停板全景看板 - 数据采集开始\n');
  const startTime = Date.now();

  loadTdxConceptData(); // 加载本地通达信概念数据

  try {
    // Step 1: 获取市场涨跌分布
    const marketDist = fetchMarketDist();

    // Step 2: 获取涨停板股票列表
    const limitUpStocks = fetchLimitUpStocks();
    const limitUpCodes = limitUpStocks.map(s => s.code);
    console.log(`  找到 ${limitUpCodes.length} 只涨停板股票\n`);

    // 获取推荐概念板块 AB版（同时产出严格+放宽）
    let recStrict = [], recLoose = [];
    try {
      const rec = fetchRecommendedConcepts();
      recStrict = rec.strict;
      recLoose = rec.loose;
    } catch (e) {
      console.error('⚠️ 推荐概念板块获取失败:', e.message);
    }

    if (limitUpCodes.length === 0) {
      console.log('⚠️ 今日无涨停板数据，生成空看板...');
      // 仍然生成看板但数据为空
      const emptyData = {
        stockMap: {},
        ladderMap: { '1': [], '2': [], '3': [], '4': [], '5+': [] },
        industryHeat: [],
        industryFlowRank: [],
        activeStocksByIndustry: {},
        marketDist,
        sectorRankings: { sw1: [], industry: [] },
        lhbCodes: [],
        recommendedConcepts: recStrict,
        recommendedConceptsLoose: recLoose,
        generatedAt: new Date().toISOString(),
        tradingDate: new Date().toISOString().split('T')[0],
      };
      const html = generateHTML(emptyData);
      fs.writeFileSync(OUTPUT_FILE, html, 'utf-8');
      console.log(`\n✅ 空看板已生成: ${OUTPUT_FILE}`);
      return;
    }

    // Step 3: 批量获取详情
    const quotes = fetchQuotes(limitUpCodes);
    const profiles = fetchProfiles(limitUpCodes);
    const capitalFlows = fetchCapitalFlow(limitUpCodes);
    const klines = fetchKlines(limitUpCodes, 8, 'day');

    // Step 4: 获取板块排行
    const sectorRankings = fetchSectorRankings();

    // Step 5: 获取龙虎榜
    const lhb = fetchLhb();

    // Step 6: 综合分析
    const analysis = analyzeData(
      limitUpCodes, quotes, profiles, capitalFlows,
      klines, sectorRankings, lhb, marketDist
    );
    analysis.recommendedConcepts = recStrict;
    analysis.recommendedConceptsLoose = recLoose;

    // Step 7: 保存数据备份
    fs.writeFileSync(DATA_FILE, JSON.stringify(analysis, null, 2), 'utf-8');
    console.log(`\n💾 数据已保存: ${DATA_FILE}`);

    // Step 8: 生成HTML
    const html = generateHTML(analysis);
    fs.writeFileSync(OUTPUT_FILE, html, 'utf-8');

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const verifiedCount = Object.keys(analysis.stockMap).length;
    console.log(`\n✅ 看板已生成: ${OUTPUT_FILE}`);
    console.log(`⏱️ 总耗时: ${elapsed}s`);
    console.log(`📊 涨停: ${verifiedCount}只（候选${limitUpCodes.length}只→验证${verifiedCount}只） | 连板最高: ${Math.max(...Object.values(analysis.stockMap).map(s => s.consecutiveLimit))}板`);

  } catch (error) {
    console.error('❌ 生成失败:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
