#!/usr/bin/env python3
"""
60分钟MACD分析工具
输入: 股票代码列表（逗号分隔）
输出: JSON {code: {signal: 'golden_cross'|'底背离'|'none', dif: float, dea: float, macd: float}}

信号定义:
- golden_cross: 零轴附近金叉 (|DIF|<=0.3 且 |DEA|<=0.3, 当前DIF>DEA且前一期DIF<=DEA)
- 底背离: 价格创近期(20根)新低但MACD柱未创新低
"""
import sys
import json
import time

def calculate_ema(values, period):
    """计算EMA"""
    if len(values) < period:
        return []
    multiplier = 2.0 / (period + 1)
    ema = [sum(values[:period]) / period]
    for price in values[period:]:
        ema.append((price - ema[-1]) * multiplier + ema[-1])
    return ema

def calculate_macd(closes):
    """计算MACD指标，返回 [(dif, dea, macd), ...]"""
    if len(closes) < 35:
        return []
    ema12 = calculate_ema(closes, 12)
    ema26 = calculate_ema(closes, 26)
    # 对齐长度
    dif = [ema12[i] - ema26[i] for i in range(len(ema26))]
    dea = calculate_ema(dif, 9)
    # 对齐DIF和DEA
    min_len = min(len(dif), len(dea))
    dif = dif[-min_len:]
    dea = dea[-min_len:]
    macd = [2 * (dif[i] - dea[i]) for i in range(min_len)]
    return list(zip(dif, dea, macd))

def detect_golden_cross(macd_data, zero_threshold=0.3):
    """检测零轴附近金叉"""
    if len(macd_data) < 2:
        return False
    latest = macd_data[-1]
    prev = macd_data[-2]
    dif, dea, macd = latest
    prev_dif, prev_dea, prev_macd = prev
    # 零轴附近
    if abs(dif) > zero_threshold or abs(dea) > zero_threshold:
        return False
    # 金叉: 当前DIF>DEA 且 前一期DIF<=DEA
    if dif > dea and prev_dif <= prev_dea:
        return True
    return False

def detect_bottom_divergence(closes, macd_data, lookback=20):
    """检测底背离: 价格创新低但MACD未创新低"""
    if len(closes) < lookback + 5 or len(macd_data) < lookback:
        return False
    price_slice = closes[-lookback:]
    macd_slice = [m[2] for m in macd_data[-lookback:]]  # MACD柱
    
    # 找最近的价格低点和对应的MACD
    min_price_idx = price_slice.index(min(price_slice))
    # 如果最新价格是近期最低
    if min_price_idx != len(price_slice) - 1:
        return False
    
    # 检查前几期的价格低点
    prev_prices = price_slice[:-5]
    if not prev_prices:
        return False
    prev_min_price = min(prev_prices)
    prev_min_idx = price_slice.index(prev_min_price)
    
    # 价格创新低
    if price_slice[-1] >= prev_min_price * 0.99:
        return False
    
    # 对应MACD没有创新低（MACD柱抬高）
    prev_macd_at_low = macd_slice[prev_min_idx]
    curr_macd = macd_slice[-1]
    if curr_macd > prev_macd_at_low:
        return True
    return False

def analyze_stock(code):
    """分析单只股票的60分钟MACD"""
    try:
        import akshare as ak
        # 转换代码格式 sh600000 -> 600000
        symbol = code.replace('sh', '').replace('sz', '').replace('bj', '')
        # 获取近5天的60分钟K线（约20根）
        import datetime
        end = datetime.datetime.now()
        start = end - datetime.timedelta(days=7)
        start_str = start.strftime('%Y%m%d')
        end_str = end.strftime('%Y%m%d')
        
        df = ak.stock_zh_a_hist_min_em(
            symbol=symbol, period='60', adjust='qfq',
            start_date=start_str, end_date=end_str
        )
        if df is None or len(df) < 35:
            return None
        
        closes = df['收盘'].astype(float).tolist()
        macd_data = calculate_macd(closes)
        if not macd_data:
            return None
        
        latest = macd_data[-1]
        signal = 'none'
        if detect_golden_cross(macd_data):
            signal = 'golden_cross'
        elif detect_bottom_divergence(closes, macd_data):
            signal = '底背离'
        
        return {
            'signal': signal,
            'dif': round(latest[0], 3),
            'dea': round(latest[1], 3),
            'macd': round(latest[2], 3),
        }
    except Exception as e:
        return {'signal': 'error', 'error': str(e)}

def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Usage: macd_60min.py <code1,code2,...>'}, ensure_ascii=False))
        sys.exit(1)
    
    codes = sys.argv[1].split(',')
    result = {}
    for code in codes:
        code = code.strip()
        if not code:
            continue
        # 添加延迟避免请求过快
        time.sleep(0.3)
        result[code] = analyze_stock(code)
    
    print(json.dumps(result, ensure_ascii=False))

if __name__ == '__main__':
    main()
