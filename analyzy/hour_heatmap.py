"""WR & avg P&L heatmapa: den v týdnu × hodina (Europe/Prague)."""
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.colors as mcolors

df = pd.read_csv('/Users/filipkrejca/Documents/trading-journal-aka/analyzy/trades.csv')
df = df[df['pnl'] != 0].copy()  # vyhoď BE

# WR a avg P&L po hodinách
hourly = df.groupby('hour').agg(
    trades=('pnl', 'count'),
    wins=('pnl', lambda x: (x > 0).sum()),
    total=('pnl', 'sum'),
    avg=('pnl', 'mean'),
).reset_index()
hourly['wr'] = hourly['wins'] / hourly['trades'] * 100

# DoW labels
dow_labels = {1: 'Po', 2: 'Út', 3: 'St', 4: 'Čt', 5: 'Pá'}

# Heatmap: dow × hour, avg P&L
pivot_pnl = df.pivot_table(index='dow', columns='hour', values='pnl', aggfunc='mean')
pivot_count = df.pivot_table(index='dow', columns='hour', values='pnl', aggfunc='count')

# === FIG 1: 2-panel summary ===
fig, axes = plt.subplots(2, 1, figsize=(14, 10), gridspec_kw={'height_ratios': [1.1, 1]})
fig.suptitle('Filip — analýza obchodů (Europe/Prague, ' + str(len(df)) + ' trades)', fontsize=14, fontweight='bold')

# --- Heatmap dow × hour
ax = axes[0]
hours_present = sorted(df['hour'].unique())
dows_present = sorted(df['dow'].unique())
data = pivot_pnl.reindex(index=dows_present, columns=hours_present)
counts = pivot_count.reindex(index=dows_present, columns=hours_present)

vmax = max(abs(data.min().min()), abs(data.max().max()))
im = ax.imshow(data.values, cmap='RdYlGn', vmin=-vmax, vmax=vmax, aspect='auto')

ax.set_xticks(range(len(hours_present)))
ax.set_xticklabels([f'{h}:00' for h in hours_present], rotation=45)
ax.set_yticks(range(len(dows_present)))
ax.set_yticklabels([dow_labels.get(d, str(d)) for d in dows_present])
ax.set_xlabel('Hodina (Europe/Prague)')
ax.set_ylabel('Den v týdnu')
ax.set_title('Průměrný P&L: den × hodina  (zelená = profit, červená = loss, číslo = počet trades)')

for i in range(len(dows_present)):
    for j in range(len(hours_present)):
        v = data.values[i, j]
        c = counts.values[i, j]
        if not np.isnan(v):
            label = f'${v:.0f}\nn={int(c)}'
            color = 'white' if abs(v) > vmax * 0.5 else 'black'
            ax.text(j, i, label, ha='center', va='center', fontsize=7, color=color, fontweight='bold')

plt.colorbar(im, ax=ax, label='Avg P&L ($)')

# --- Bar chart: WR + avg P&L po hodinách
ax2 = axes[1]
hourly_sorted = hourly.sort_values('hour')
x = np.arange(len(hourly_sorted))
colors = ['#22c55e' if v > 0 else '#ef4444' for v in hourly_sorted['avg']]
bars = ax2.bar(x, hourly_sorted['avg'], color=colors, alpha=0.7, edgecolor='black')
ax2.set_xticks(x)
ax2.set_xticklabels([f'{h}:00' for h in hourly_sorted['hour']], rotation=45)
ax2.set_ylabel('Avg P&L ($)', color='black')
ax2.axhline(0, color='black', linewidth=0.5)
ax2.set_title('Průměrný P&L po hodinách (Europe/Prague)')

# Annotate WR + trade count
for i, (_, row) in enumerate(hourly_sorted.iterrows()):
    y = row['avg']
    label = f"WR {row['wr']:.0f}%\nn={int(row['trades'])}"
    va = 'bottom' if y >= 0 else 'top'
    offset = max(abs(hourly_sorted['avg'])) * 0.03
    ax2.text(i, y + (offset if y >= 0 else -offset), label,
             ha='center', va=va, fontsize=8, fontweight='bold')

ax2.grid(axis='y', alpha=0.3)

plt.tight_layout()
plt.savefig('/Users/filipkrejca/Documents/trading-journal-aka/analyzy/hour_heatmap.png', dpi=140, bbox_inches='tight')
print('saved hour_heatmap.png')

# === TEXT REPORT ===
print('\n=== HOURLY BREAKDOWN ===')
print(hourly_sorted.to_string(index=False, float_format=lambda x: f'{x:.2f}'))

print('\n=== TOP 3 WORST HOURS (by avg P&L) ===')
print(hourly.nsmallest(3, 'avg')[['hour', 'trades', 'wr', 'avg', 'total']].to_string(index=False))

print('\n=== TOP 3 BEST HOURS ===')
print(hourly.nlargest(3, 'avg')[['hour', 'trades', 'wr', 'avg', 'total']].to_string(index=False))

print('\n=== OVERALL ===')
print(f"Trades: {len(df)}  Wins: {(df['pnl']>0).sum()}  Losses: {(df['pnl']<0).sum()}")
print(f"WR: {(df['pnl']>0).sum()/len(df)*100:.1f}%")
print(f"Total P&L: ${df['pnl'].sum():.2f}")
print(f"Profit factor: {df[df['pnl']>0]['pnl'].sum() / abs(df[df['pnl']<0]['pnl'].sum()):.2f}")
print(f"Avg win: ${df[df['pnl']>0]['pnl'].mean():.2f}   Avg loss: ${df[df['pnl']<0]['pnl'].mean():.2f}")
