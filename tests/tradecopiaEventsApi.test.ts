import { describe, expect, it, vi } from 'vitest';
import handler from '../api/tradecopia-events';
describe('retired Tradecopia ingress', () => {
  it.each(['POST', 'GET'])('rejects %s without sending or storing events', method => {
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    handler({ method, body: { events: [{ type: 'trade_closed' }] } } as never, res as never);
    expect(res.status).toHaveBeenCalledWith(410);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'tradecopia-retired' });
  });
});
