import { Trade } from '../../types';

export const sendDiscordNotification = async (trade: Partial<Trade>, action: 'CREATE' | 'UPDATE' | 'DELETE') => {
    const webhookUrl = import.meta.env.VITE_DISCORD_WEBHOOK_URL || process.env.VITE_DISCORD_WEBHOOK_URL;

    if (!webhookUrl) {
        console.warn('VITE_DISCORD_WEBHOOK_URL is not set in environment variables.');
        return;
    }

    let color = 3447003; // Blue default
    let title = `Trade ${action}`;

    const pnlValue = trade.pnl || 0;
    const pnlString = pnlValue > 0 ? `+$${pnlValue.toFixed(2)}` : (pnlValue < 0 ? `-$${Math.abs(pnlValue).toFixed(2)}` : '$0.00');
    const outcomeEmoji = pnlValue > 0 ? '✅' : (pnlValue < 0 ? '❌' : '⏺️');
    const instrumentName = trade.instrument || trade.symbol || 'Unknown';

    if (action === 'CREATE') {
        color = pnlValue > 0 ? 3066993 : (pnlValue < 0 ? 15158332 : 3447003);
        title = `${outcomeEmoji} New Trade: ${instrumentName}`;
    } else if (action === 'UPDATE') {
        color = 16776960;
        title = `🔄 Trade Updated: ${instrumentName}`;
    } else if (action === 'DELETE') {
        color = 15158332;
        title = `🗑️ Trade Deleted: ${instrumentName}`;
    }

    const screenshots = (trade as any).screenshots || (trade.screenshot ? [trade.screenshot] : []);
    const validScreenshot = screenshots.find((s: string) => s && s.startsWith('http'));

    const embed: any = {
        title: title,
        color: color,
        fields: [
            {
                name: 'Direction',
                value: trade.direction || 'N/A',
                inline: true,
            },
            {
                name: 'PnL',
                value: pnlString,
                inline: true,
            },
            {
                name: 'Setup',
                value: (trade as any).setup || 'N/A',
                inline: true,
            }
        ],
        timestamp: new Date().toISOString(),
    };

    if (validScreenshot) {
        embed.image = { url: validScreenshot };
    }

    const payload = {
        content: trade.notes ? `**Notes:**\n${trade.notes}` : undefined,
        embeds: [embed],
    };

    try {
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            console.error(`Failed to send Discord notification: ${response.status} ${response.statusText}`);
        }
    } catch (error) {
        console.error('Error sending Discord notification:', error);
    }
};
