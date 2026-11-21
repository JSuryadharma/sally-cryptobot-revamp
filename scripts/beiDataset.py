# Builds IDX_DATA_DIR from the BEI dataset github.com/wildangunawan/Dataset-Saham-IDX (CC BY-NC).
# Download Saham/LQ45/<SYM>.csv into the folder first, then: python3 scripts/beiDataset.py /var/lib/idxdata
import sys
import csv, json, datetime, glob, os
D=sys.argv[1] if len(sys.argv) > 1 else '/var/lib/idxdata'
series={}
for f in sorted(glob.glob(D+'/*.csv')):
    s=os.path.basename(f)[:-4]
    rows=[r for r in csv.DictReader(open(f)) if float(r['volume'] or 0)>0 and float(r['close'] or 0)>0]
    bars=[]; adj_events=[]
    for r in rows:
        o=float(r['open_price'] or 0) or float(r['first_trade'] or 0) or float(r['previous'])
        bars.append(dict(date=r['date'],open=o,high=float(r['high']),low=float(r['low']),close=float(r['close']),volume=float(r['volume']),prev=float(r['previous'])))
    bars=[b for b in bars if datetime.date.fromisoformat(b['date']).weekday()<5]
    # corporate-action adjustment: previous (BEI reference) differs from yesterday's close.
    # Factors from raw values first, then applied cumulatively to earlier bars.
    factors=[1.0]*len(bars)
    for k in range(1,len(bars)):
        f_=bars[k]['prev']/bars[k-1]['close']
        if abs(f_-1)>0.02: factors[k]=f_; adj_events.append((bars[k]['date'],round(f_,4)))
    cum=1.0
    for k in range(len(bars)-1,-1,-1):
        b=bars[k]
        for key in ('open','high','low','close'): b[key]*=cum
        b['volume']/=cum
        cum*=factors[k]
    out=[]
    for b in bars:
        d=datetime.datetime.strptime(b['date'],'%Y-%m-%d').replace(tzinfo=datetime.timezone.utc)
        close_ms=int((d+datetime.timedelta(hours=9,minutes=15)).timestamp()*1000)
        out.append(dict(time=close_ms//1000-86400,date=b['date'],open=b['open'],high=max(b['high'],b['open'],b['close']),low=min(b['low'],b['open'],b['close']),close=b['close'],volume=b['volume'],closeTime=close_ms))
    series[s]=out
    json.dump(out,open(f'{D}/{s}.json','w'))
    print(s,len(out),out[0]['date'],out[-1]['date'],'adjust:',adj_events[:4])
# equal-weight proxy for IHSG from the 16 names
dates=sorted(set(b['date'] for v in series.values() for b in v))
base={s:v[0]['close'] for s,v in series.items()}
bydate={s:{b['date']:b for b in v} for s,v in series.items()}
last={}
idx=[]
for dt in dates:
    vals=[]
    for s in series:
        b=bydate[s].get(dt)
        if b: last[s]=b['close']/base[s]
        if s in last: vals.append(last[s])
    lvl=1000*sum(vals)/len(vals)
    d=datetime.datetime.strptime(dt,'%Y-%m-%d').replace(tzinfo=datetime.timezone.utc)
    cm=int((d+datetime.timedelta(hours=9,minutes=15)).timestamp()*1000)
    idx.append(dict(time=cm//1000-86400,date=dt,open=lvl,high=lvl,low=lvl,close=lvl,volume=0,closeTime=cm))
json.dump(idx,open(f'{D}/IHSG.json','w'))
print('IHSG proxy',len(idx),idx[0]['close'],idx[-1]['close'])
