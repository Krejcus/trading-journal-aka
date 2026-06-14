"""Full dashboard — 12 grafů z trade dat (Europe/Prague TZ)."""
import json, re
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.colors import LinearSegmentedColormap

# === LOAD ===
with open('/Users/filipkrejca/Documents/trading-journal-aka/analyzy/trades_full.json') as f:
    raw = json.load(f)
df = pd.DataFrame(raw)
df['pnl'] = df['pnl'].astype(float)

# Duration v minutách
def parse_dur(s):
    if not s: return 0
    h = re.search(r'(\d+)\s*h', s)
    m = re.search(r'(\d+)\s*m', s)
    return (int(h.group(1))*60 if h else 0) + (int(m.group(1)) if m else 0)
df['dur_min'] = df['duration_raw'].apply(parse_dur)

# Aggregát per den (kvůli duplikátům napříč 3 účty) — pro equity curve
df_day = df.groupby('day').agg(pnl=('pnl','sum')).reset_index().sort_values('day')
df_day['cum_pnl'] = df_day['pnl'].cumsum()
df_day['peak'] = df_day['cum_pnl'].cummax()
df_day['dd'] = df_day['cum_pnl'] - df_day['peak']

dow_labels = {1:'Po',2:'Út',3:'St',4:'Čt',5:'Pá',6:'So',0:'Ne'}
month_labels = {1:'Led',2:'Úno',3:'Bře',4:'Dub',5:'Kvě',6:'Čer',7:'Čec',8:'Srp',9:'Zář',10:'Říj',11:'Lis',12:'Pro'}

# === FIGURE ===
fig = plt.figure(figsize=(22, 28))
gs = fig.add_gridspec(6, 2, hspace=0.55, wspace=0.25)
plt.rcParams.update({'font.size': 9})
fig.suptitle(f'Filip — Trading Dashboard  ({len(df)} trades, {df["day"].min()} → {df["day"].max()})',
             fontsize=17, fontweight='bold', y=0.995)

# Helper: barva podle pnl
def pnl_colors(vals, alpha=0.85):
    return ['#22c55e' if v>0 else ('#ef4444' if v<0 else '#94a3b8') for v in vals]

# === 1. EQUITY CURVE + DRAWDOWN ===
ax = fig.add_subplot(gs[0, :])
ax.fill_between(range(len(df_day)), df_day['cum_pnl'], 0, where=df_day['cum_pnl']>=0,
                color='#22c55e', alpha=0.2, interpolate=True)
ax.fill_between(range(len(df_day)), df_day['cum_pnl'], 0, where=df_day['cum_pnl']<0,
                color='#ef4444', alpha=0.2, interpolate=True)
ax.plot(range(len(df_day)), df_day['cum_pnl'], color='#0ea5e9', linewidth=2.2, label='Cumulative P&L')
ax.plot(range(len(df_day)), df_day['peak'], color='#22c55e', linewidth=1, linestyle=':', alpha=0.7, label='Peak')
ax2 = ax.twinx()
ax2.fill_between(range(len(df_day)), df_day['dd'], 0, color='#ef4444', alpha=0.3, label='Drawdown')
ax2.set_ylabel('Drawdown ($)', color='#ef4444')
ax2.set_ylim(df_day['dd'].min()*1.5, 0)
ax.set_title('① Equity Curve + Drawdown', fontweight='bold', fontsize=12)
ax.set_ylabel('Cumulative P&L ($)')
ax.grid(alpha=0.3)
ax.set_xticks(range(0, len(df_day), max(1, len(df_day)//12)))
ax.set_xticklabels([df_day['day'].iloc[i] for i in range(0, len(df_day), max(1, len(df_day)//12))], rotation=45)
ax.legend(loc='upper left'); ax2.legend(loc='upper right')

# === 2. HEATMAP dow × hour ===
ax = fig.add_subplot(gs[1, 0])
hours = sorted(df['hour'].unique())
dows = sorted(df['dow'].unique())
pivot = df.pivot_table(index='dow', columns='hour', values='pnl', aggfunc='mean').reindex(index=dows, columns=hours)
counts = df.pivot_table(index='dow', columns='hour', values='pnl', aggfunc='count').reindex(index=dows, columns=hours)
vmax = max(abs(pivot.min().min()), abs(pivot.max().max()))
im = ax.imshow(pivot.values, cmap='RdYlGn', vmin=-vmax, vmax=vmax, aspect='auto')
ax.set_xticks(range(len(hours))); ax.set_xticklabels([f'{h}h' for h in hours], rotation=45)
ax.set_yticks(range(len(dows))); ax.set_yticklabels([dow_labels.get(d,'?') for d in dows])
for i in range(len(dows)):
    for j in range(len(hours)):
        v = pivot.values[i,j]; c = counts.values[i,j]
        if not np.isnan(v):
            ax.text(j, i, f'${v:.0f}\n({int(c)})', ha='center', va='center', fontsize=6.5,
                    color='white' if abs(v)>vmax*0.5 else 'black', fontweight='bold')
ax.set_title('② Heatmapa: den × hodina (avg P&L)', fontweight='bold', fontsize=11)
plt.colorbar(im, ax=ax, label='Avg P&L $')

# === 3. WR po hodinách ===
ax = fig.add_subplot(gs[1, 1])
hourly = df[df['pnl']!=0].groupby('hour').agg(n=('pnl','count'), wins=('pnl', lambda x:(x>0).sum()), tot=('pnl','sum')).reset_index()
hourly['wr'] = hourly['wins']/hourly['n']*100
hourly['avg'] = hourly['tot']/hourly['n']
hourly = hourly.sort_values('hour')
colors = pnl_colors(hourly['avg'])
bars = ax.bar(hourly['hour'].astype(str)+':00', hourly['avg'], color=colors, edgecolor='black', alpha=0.85)
ax.axhline(0, color='black', lw=0.5)
ax.set_title('③ Avg P&L po hodinách (label: WR %, n=trades)', fontweight='bold', fontsize=11)
ax.set_ylabel('Avg P&L $')
ax.tick_params(axis='x', rotation=45)
offset = max(abs(hourly['avg'])) * 0.04
for i, (_, r) in enumerate(hourly.iterrows()):
    y = r['avg']
    va = 'bottom' if y>=0 else 'top'
    ax.text(i, y + (offset if y>=0 else -offset), f"{r['wr']:.0f}%\nn={int(r['n'])}",
            ha='center', va=va, fontsize=7, fontweight='bold')
ax.grid(axis='y', alpha=0.3)

# === 4. WR po dnech v týdnu ===
ax = fig.add_subplot(gs[2, 0])
dowly = df[df['pnl']!=0].groupby('dow').agg(n=('pnl','count'), wins=('pnl', lambda x:(x>0).sum()), tot=('pnl','sum')).reset_index()
dowly['wr'] = dowly['wins']/dowly['n']*100
dowly['avg'] = dowly['tot']/dowly['n']
dowly = dowly.sort_values('dow')
colors = pnl_colors(dowly['avg'])
ax.bar([dow_labels[d] for d in dowly['dow']], dowly['tot'], color=colors, edgecolor='black', alpha=0.85)
ax.axhline(0, color='black', lw=0.5)
ax.set_title('④ Total P&L po dnech v týdnu', fontweight='bold', fontsize=11)
ax.set_ylabel('Total P&L $')
for i, (_, r) in enumerate(dowly.iterrows()):
    y = r['tot']
    va = 'bottom' if y>=0 else 'top'
    off = max(abs(dowly['tot']))*0.03
    ax.text(i, y + (off if y>=0 else -off), f"WR {r['wr']:.0f}%\nn={int(r['n'])}",
            ha='center', va=va, fontsize=8, fontweight='bold')
ax.grid(axis='y', alpha=0.3)

# === 5. HISTOGRAM P&L ===
ax = fig.add_subplot(gs[2, 1])
nonzero = df[df['pnl']!=0]
ax.hist(nonzero['pnl'], bins=30, color='#0ea5e9', edgecolor='black', alpha=0.75)
ax.axvline(0, color='black', lw=1)
ax.axvline(nonzero['pnl'].mean(), color='#22c55e', lw=2, linestyle='--', label=f"Mean ${nonzero['pnl'].mean():.0f}")
ax.axvline(nonzero['pnl'].median(), color='#a855f7', lw=2, linestyle='--', label=f"Median ${nonzero['pnl'].median():.0f}")
ax.set_title('⑤ Distribuce P&L', fontweight='bold', fontsize=11)
ax.set_xlabel('P&L $'); ax.set_ylabel('Počet trades')
ax.legend(); ax.grid(axis='y', alpha=0.3)

# === 6. WIN vs LOSS SIZE comparison ===
ax = fig.add_subplot(gs[3, 0])
wins = nonzero[nonzero['pnl']>0]['pnl']
losses = nonzero[nonzero['pnl']<0]['pnl'].abs()
positions = [1, 2]
parts = ax.violinplot([wins, losses], positions=positions, showmedians=True, widths=0.7)
for pc, color in zip(parts['bodies'], ['#22c55e', '#ef4444']):
    pc.set_facecolor(color); pc.set_alpha(0.6)
ax.set_xticks(positions); ax.set_xticklabels([f'Wins (n={len(wins)})', f'Losses (n={len(losses)})'])
ax.set_ylabel('|P&L| $')
ax.set_title(f'⑥ Win vs Loss velikost  |  RR={wins.mean()/losses.mean():.2f}', fontweight='bold', fontsize=11)
ax.grid(axis='y', alpha=0.3)
ax.text(1, wins.mean(), f'  μ ${wins.mean():.0f}', va='center', fontweight='bold', color='#16a34a')
ax.text(2, losses.mean(), f'  μ ${losses.mean():.0f}', va='center', fontweight='bold', color='#dc2626')

# === 7. MĚSÍČNÍ PERFORMANCE ===
ax = fig.add_subplot(gs[3, 1])
df['ym'] = df.apply(lambda r: f"{int(r['year'])}-{int(r['month']):02d}", axis=1)
monthly = df.groupby('ym').agg(pnl=('pnl','sum'), n=('pnl','count'), wins=('pnl',lambda x:(x>0).sum())).reset_index().sort_values('ym')
monthly['wr'] = monthly['wins']/monthly['n']*100
colors = pnl_colors(monthly['pnl'])
ax.bar(monthly['ym'], monthly['pnl'], color=colors, edgecolor='black', alpha=0.85)
ax.axhline(0, color='black', lw=0.5)
ax.set_title('⑦ Měsíční P&L', fontweight='bold', fontsize=11)
ax.set_ylabel('P&L $')
ax.tick_params(axis='x', rotation=45)
for i, (_, r) in enumerate(monthly.iterrows()):
    y = r['pnl']; off = max(abs(monthly['pnl']))*0.03
    va = 'bottom' if y>=0 else 'top'
    ax.text(i, y + (off if y>=0 else -off), f"WR {r['wr']:.0f}%\nn={int(r['n'])}",
            ha='center', va=va, fontsize=7, fontweight='bold')
ax.grid(axis='y', alpha=0.3)

# === 8. P&L PER ÚČET ===
ax = fig.add_subplot(gs[4, 0])
acc = df.groupby('account').agg(pnl=('pnl','sum'), n=('pnl','count'), wins=('pnl', lambda x:(x>0).sum())).reset_index().sort_values('pnl')
acc['wr'] = acc['wins']/acc['n']*100
colors = pnl_colors(acc['pnl'])
ax.barh(acc['account'], acc['pnl'], color=colors, edgecolor='black', alpha=0.85)
ax.axvline(0, color='black', lw=0.5)
ax.set_title('⑧ P&L per účet', fontweight='bold', fontsize=11)
ax.set_xlabel('Total P&L $')
for i, (_, r) in enumerate(acc.iterrows()):
    x = r['pnl']; off = max(abs(acc['pnl']))*0.02
    ha = 'left' if x>=0 else 'right'
    ax.text(x + (off if x>=0 else -off), i, f"${x:,.0f}  ({r['wr']:.0f}% / n={int(r['n'])})",
            ha=ha, va='center', fontsize=8, fontweight='bold')
ax.grid(axis='x', alpha=0.3)

# === 9. LONG vs SHORT ===
ax = fig.add_subplot(gs[4, 1])
df['dir_norm'] = df['direction'].str.upper()
dirsum = df.groupby('dir_norm').agg(pnl=('pnl','sum'), n=('pnl','count'), wins=('pnl', lambda x:(x>0).sum())).reset_index()
dirsum['wr'] = dirsum['wins']/dirsum['n']*100
colors = pnl_colors(dirsum['pnl'])
bars = ax.bar(dirsum['dir_norm'], dirsum['pnl'], color=colors, edgecolor='black', alpha=0.85, width=0.5)
ax.axhline(0, color='black', lw=0.5)
ax.set_title('⑨ Long vs Short', fontweight='bold', fontsize=11)
ax.set_ylabel('Total P&L $')
for i, (_, r) in enumerate(dirsum.iterrows()):
    y = r['pnl']; off = max(abs(dirsum['pnl']))*0.03
    va = 'bottom' if y>=0 else 'top'
    ax.text(i, y + (off if y>=0 else -off), f"${y:,.0f}\nWR {r['wr']:.0f}%\nn={int(r['n'])}",
            ha='center', va=va, fontsize=9, fontweight='bold')
ax.grid(axis='y', alpha=0.3)

# === 10. DURATION vs P&L ===
ax = fig.add_subplot(gs[5, 0])
dur_df = df[df['dur_min']>0]
colors = pnl_colors(dur_df['pnl'])
ax.scatter(dur_df['dur_min'], dur_df['pnl'], c=colors, alpha=0.6, s=50, edgecolors='black')
ax.axhline(0, color='black', lw=0.5)
ax.set_xscale('log')
ax.set_title('⑩ Hold time vs P&L (log x)', fontweight='bold', fontsize=11)
ax.set_xlabel('Duration (min, log scale)'); ax.set_ylabel('P&L $')
ax.grid(alpha=0.3)
# Linear regression for vibe
if len(dur_df) > 5:
    z = np.polyfit(np.log10(dur_df['dur_min']), dur_df['pnl'], 1)
    xs = np.logspace(np.log10(dur_df['dur_min'].min()), np.log10(dur_df['dur_min'].max()), 30)
    ax.plot(xs, z[0]*np.log10(xs)+z[1], color='#0ea5e9', linewidth=2, linestyle='--', label=f'Trend')
    ax.legend()

# === 11. STREAK ===
ax = fig.add_subplot(gs[5, 1])
# Den-level streaks
df_day_sign = np.sign(df_day['pnl'])
streaks_w, streaks_l = [], []
cur = 0; cur_sign = 0
for s in df_day_sign:
    if s == cur_sign and s != 0:
        cur += 1
    else:
        if cur_sign > 0: streaks_w.append(cur)
        elif cur_sign < 0: streaks_l.append(cur)
        cur = 1; cur_sign = s
if cur_sign > 0: streaks_w.append(cur)
elif cur_sign < 0: streaks_l.append(cur)

max_s = max(max(streaks_w, default=0), max(streaks_l, default=0))
bins = list(range(1, max_s+2))
ax.hist([streaks_w, streaks_l], bins=bins, label=[f'Win streaks (max {max(streaks_w, default=0)})',
                                                   f'Loss streaks (max {max(streaks_l, default=0)})'],
        color=['#22c55e','#ef4444'], edgecolor='black', alpha=0.85)
ax.set_title('⑪ Win/Loss streak (po dnech)', fontweight='bold', fontsize=11)
ax.set_xlabel('Délka streaku (dny)'); ax.set_ylabel('Počet')
ax.legend(); ax.grid(axis='y', alpha=0.3)

# === SUMMARY KARTA pod vším ===
ax = fig.add_subplot(gs[0:1, 0])  # překryje horní část — necháme to být, není to elegantní
# vlastně NE, použijeme volný prostor lépe: přidám textový summary block dole

plt.tight_layout(rect=[0, 0, 1, 0.985])
out = '/Users/filipkrejca/Documents/trading-journal-aka/analyzy/dashboard.png'
plt.savefig(out, dpi=130, bbox_inches='tight', facecolor='white')
print('saved:', out)

# === TEXT REPORT ===
total = df['pnl'].sum()
non = df[df['pnl']!=0]
wins_all = non[non['pnl']>0]
losses_all = non[non['pnl']<0]
print('\n' + '='*60)
print('SOUHRN')
print('='*60)
print(f"Period: {df['day'].min()} → {df['day'].max()}  ({df['day'].nunique()} unikátních dnů)")
print(f"Trades: {len(df)}  (BE: {(df['pnl']==0).sum()})")
print(f"Total P&L: ${total:,.2f}")
print(f"Win Rate: {len(wins_all)/len(non)*100:.1f}%")
print(f"Profit Factor: {wins_all['pnl'].sum()/abs(losses_all['pnl'].sum()):.2f}")
print(f"Avg Win:  ${wins_all['pnl'].mean():.2f}")
print(f"Avg Loss: ${losses_all['pnl'].mean():.2f}")
print(f"RR:       {wins_all['pnl'].mean()/abs(losses_all['pnl'].mean()):.2f}")
print(f"Max Win:  ${wins_all['pnl'].max():.2f}")
print(f"Max Loss: ${losses_all['pnl'].min():.2f}")
print(f"Max DD:   ${df_day['dd'].min():,.2f}")
print(f"Max win streak (dny):  {max(streaks_w, default=0)}")
print(f"Max loss streak (dny): {max(streaks_l, default=0)}")
print(f"\nPer účet:")
print(acc[['account','pnl','n','wr']].to_string(index=False, float_format=lambda x: f'{x:.2f}'))
