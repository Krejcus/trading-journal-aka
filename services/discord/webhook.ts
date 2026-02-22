import { Trade } from '../../types';

export const sendDiscordNotification = async (trade: Partial<Trade>, action: 'CREATE' | 'UPDATE' | 'DELETE') => {
    const webhookUrl = import.meta.env.VITE_DISCORD_WEBHOOK_URL || process.env.VITE_DISCORD_WEBHOOK_URL;

    if (!webhookUrl) {
        console.warn('VITE_DISCORD_WEBHOOK_URL is not set in environment variables.');
        return;
    }

    let color = 3447003; // Blue default
    let title = `Trade ${action}`;

    if (action === 'CREATE') {
        color = trade.pnl && trade.pnl > 0 ? 3066993 : (trade.pnl && trade.pnl < 0 ? 15158332 : 3447003); // Green / Red / Blue
        title = `New Trade Added: ${trade.symbol}`;
    } else if (action === 'UPDATE') {
        color = 16776960; // Yellow
        title = `Trade Updated: ${trade.symbol}`;
    } else if (action === 'DELETE') {
        color = 15158332; // Red
        title = `Trade Deleted: ${trade.symbol}`;
    }

    const pnlString = trade.pnl !== undefined ? (trade.pnl > 0 ? `+$${trade.pnl}` : `-$${Math.abs(trade.pnl)}`) : 'N/A';

    const embed = {
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

    const payload = {
        content: `**Notes:**\n${(trade as any).notes ? (trade as any).notes : 'No notes provided.'}`,
        embeds: [embed],
    }

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
