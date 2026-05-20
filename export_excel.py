#!/usr/bin/env python3
"""
导出推荐股票到Excel
输入: JSON对象 {strict: [...], loose: [...], negativeCodes: [...]}
输出: xls文件
"""
import json
import sys
import os

try:
    import pandas as pd
except ImportError:
    print("❌ pandas not installed")
    sys.exit(1)

def main():
    if len(sys.argv) < 3:
        print("Usage: export_excel.py <input_json> <output_xls>")
        sys.exit(1)

    input_json = sys.argv[1]
    output_xls = sys.argv[2]

    with open(input_json, 'r', encoding='utf-8') as f:
        data = json.load(f)

    negativeSet = set(data.get('negativeCodes', []))
    rows = []

    # 严格推荐
    for concept in data.get('strict', []):
        for s in concept.get('stocks', []):
            rows.append({
                '股票代码': s.get('code', ''),
                '股票名称': s.get('name', ''),
                '所属概念': concept.get('name', ''),
                '推荐类型': '严格',
                '当前价格': s.get('price', 0),
                '涨跌幅%': round(s.get('changePct', 0), 2),
                '10日涨幅%': round(s.get('chg10d', 0), 2),
                '3日换手%': round(s.get('turnover3d', 0), 2),
                '利空预警': '⚠️ 有' if s.get('code') in negativeSet else '',
            })

    # 备选推荐
    for concept in data.get('loose', []):
        for s in concept.get('stocks', []):
            rows.append({
                '股票代码': s.get('code', ''),
                '股票名称': s.get('name', ''),
                '所属概念': concept.get('name', ''),
                '推荐类型': '备选',
                '当前价格': s.get('price', 0),
                '涨跌幅%': round(s.get('changePct', 0), 2),
                '10日涨幅%': round(s.get('chg10d', 0), 2),
                '3日换手%': round(s.get('turnover3d', 0), 2),
                '利空预警': '⚠️ 有' if s.get('code') in negativeSet else '',
            })

    if not rows:
        print("⚠️ 无推荐股票数据")
        sys.exit(0)

    df = pd.DataFrame(rows)

    # 使用openpyxl引擎保存为xlsx（.xls需要xlwt，可能未安装）
    root, ext = os.path.splitext(output_xls)
    output_xlsx = root + '.xlsx'
    df.to_excel(output_xlsx, index=False, sheet_name='推荐股票', engine='openpyxl')
    print(f"✅ Excel已导出: {output_xlsx}")

if __name__ == '__main__':
    main()
