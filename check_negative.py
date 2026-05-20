#!/usr/bin/env python3
"""
检测推荐股票近期是否有利空公告
输入: JSON数组 ['sz002015', 'sh600000', ...]
输出: JSON数组 ['sz002015', ...] 有厉空的股票代码
"""
import json
import sys
import re
from datetime import datetime, timedelta

try:
    import akshare as ak
except ImportError:
    print(json.dumps([]))
    sys.exit(0)

# 利空关键词
NEGATIVE_KEYWORDS = [
    '减持', '预亏', '亏损', '警示', '立案', '问询', '监管', '处罚',
    '退市', '利空', '暴雷', '违规', '造假', '调查', '冻结', '质押',
    '违约', '逾期', '降评级', '下调', '卖出评级', '看空', '业绩下滑',
    '净利润下降', '亏损扩大', '披星戴帽', '暂停上市', '终止上市',
    '被调查', '被问询', '被处罚', '被立案', '重大违法', '财务造假',
    '资金占用', '违规担保', '债务危机', '破产', '重整', '清算',
    '实控人变更', '控制权变更', '股权冻结', '股份冻结', '司法冻结',
    '强制执行', '失信', '被执行', '限制消费', '高管离职', '董事长辞职',
    '总经理辞职', '核心人员离职', '产品召回', '安全事故', '环保处罚',
    '停产', '限产', '关停', '整顿', '整改', '通报批评', '公开谴责',
    '纪律处分', '行政处罚', '市场禁入', '内幕交易', '操纵市场',
    '信息披露违规', '未及时披露', '虚假陈述', '误导性陈述',
    '关联交易', '利益输送', '掏空', '占用', '担保', '诉讼', '仲裁',
    '赔偿', '和解', '撤诉', '败诉', '强制执行', '资产减值', '商誉减值',
    '存货跌价', '坏账', '核销', '重组失败', '并购失败', '交易终止',
    '合同终止', '订单取消', '客户流失', '供应商问题', '产品质量',
    '召回', '下架', '禁售', '禁运', '制裁', '黑名单', '反垄断',
    '垄断', '价格操纵', '串通投标', '商业贿赂', '行贿', '受贿',
    '贪污', '挪用', '职务侵占', '非法经营', '非法吸收', '非法集资',
    '合同纠纷', '债务纠纷', '股权纠纷', '知识产权', '专利侵权',
    '商标侵权', '著作权', '不正当竞争', '商业秘密', '泄露',
    '数据泄露', '信息安全', '网络安全', '系统故障', '宕机',
    '产能利用率', '开工率', '下滑', '下降', '萎缩', '萎缩',
    '不及预期', '低于预期', 'miss', '预警', '风险提示', '风险警示',
    'ST', '*ST', '退市风险', '面值退市', '市值退市', '财务退市',
    '规范类退市', '重大违法退市', '强制退市', '主动退市',
]

def check_stock(code):
    """检查单只股票是否有近期利空公告"""
    try:
        # 提取纯数字代码
        pure = re.sub(r'^(sh|sz|bj)', '', code)
        end = datetime.now().strftime('%Y%m%d')
        begin = (datetime.now() - timedelta(days=7)).strftime('%Y%m%d')

        # 获取全部公告
        df = ak.stock_individual_notice_report(
            security=pure,
            symbol='全部',
            begin_date=begin,
            end_date=end
        )
        if df is None or df.empty:
            return False

        # 检查标题中是否包含利空关键词
        titles = df['公告标题'].astype(str).tolist() if '公告标题' in df.columns else []
        for title in titles:
            for kw in NEGATIVE_KEYWORDS:
                if kw in title:
                    return True
        return False
    except Exception as e:
        return False

def main():
    if len(sys.argv) < 2:
        print(json.dumps([]))
        return

    try:
        codes = json.loads(sys.argv[1])
    except:
        print(json.dumps([]))
        return

    result = []
    for code in codes:
        if check_stock(code):
            result.append(code)

    print(json.dumps(result))

if __name__ == '__main__':
    main()
