const Redis = require('ioredis');

const redis = new Redis({
    host: 'proven-mullet-72869.upstash.io',
    port: 6379,
    password: 'gQAAAAAAARylAAIgcDFiMTE3ZTg1ZmI5Yzg0MWEwODFiMjUwZWExMjcyZjUxNA',
    tls: {}
});

function generateLicenseKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const parts = [];
    for (let i = 0; i < 4; i++) {
        let part = '';
        for (let j = 0; j < 4; j++) {
            part += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        parts.push(part);
    }
    return `UCGG-${parts.join('-')}`;
}

function formatDate(date) {
    return date.toISOString().replace('T', ' ').substring(0, 19);
}

function getExpiryDate(duration) {
    if (duration === 0) return 'Permanent';
    const date = new Date();
    date.setDate(date.getDate() + duration);
    return formatDate(date);
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const url = req.url;
    const path = url.split('?')[0];

    try {
        // GET /api/stats
        if (path === '/api/stats' && req.method === 'GET') {
            const keys = await redis.keys('license:*');
            let total = 0, active = 0, expired = 0, totalUsage = 0;
            
            for (const key of keys) {
                total++;
                const data = await redis.get(key);
                if (data) {
                    const lic = JSON.parse(data);
                    if (lic.status === 'active') {
                        if (lic.expires_at !== 'Permanent' && new Date(lic.expires_at) < new Date()) {
                            lic.status = 'expired';
                            await redis.set(key, JSON.stringify(lic));
                            expired++;
                        } else {
                            active++;
                        }
                    } else if (lic.status === 'expired') {
                        expired++;
                    }
                    totalUsage += lic.usage_count || 0;
                }
            }
            
            res.json({ total, active, expired, total_usage: totalUsage });
            return;
        }

        // GET /api/licenses
        if (path === '/api/licenses' && req.method === 'GET') {
            const keys = await redis.keys('license:*');
            const licenses = [];
            
            for (const key of keys) {
                const data = await redis.get(key);
                if (data) {
                    const lic = JSON.parse(data);
                    // Check expired
                    if (lic.status === 'active' && lic.expires_at !== 'Permanent' && new Date(lic.expires_at) < new Date()) {
                        lic.status = 'expired';
                        await redis.set(key, JSON.stringify(lic));
                    }
                    licenses.push(lic);
                }
            }
            
            licenses.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            res.json({ licenses });
            return;
        }

        // POST /api/generate
        if (path === '/api/generate' && req.method === 'POST') {
            const { duration } = req.body;
            const key = generateLicenseKey();
            const now = formatDate(new Date());
            const expires_at = getExpiryDate(duration);
            
            const licenseData = {
                key,
                created_at: now,
                expires_at,
                duration: duration || 30,
                status: 'active',
                usage_count: 0,
                last_used: now
            };
            
            await redis.set(`license:${key}`, JSON.stringify(licenseData));
            res.json({ success: true, key, ...licenseData });
            return;
        }

        // POST /api/verify
        if (path === '/api/verify' && req.method === 'POST') {
            const { key } = req.body;
            if (!key) {
                res.json({ valid: false, message: 'Key is required' });
                return;
            }
            
            const data = await redis.get(`license:${key}`);
            if (!data) {
                res.json({ valid: false, message: 'License key not found' });
                return;
            }
            
            const lic = JSON.parse(data);
            
            if (lic.status === 'revoked') {
                res.json({ valid: false, message: 'License has been revoked' });
                return;
            }
            
            if (lic.expires_at !== 'Permanent' && new Date(lic.expires_at) < new Date()) {
                lic.status = 'expired';
                await redis.set(`license:${key}`, JSON.stringify(lic));
                res.json({ valid: false, message: 'License has expired' });
                return;
            }
            
            // Update usage
            lic.usage_count = (lic.usage_count || 0) + 1;
            lic.last_used = formatDate(new Date());
            await redis.set(`license:${key}`, JSON.stringify(lic));
            
            res.json({
                valid: true,
                key: lic.key,
                status: lic.status,
                expires_at: lic.expires_at,
                usage_count: lic.usage_count,
                created_at: lic.created_at
            });
            return;
        }

        // POST /api/revoke
        if (path === '/api/revoke' && req.method === 'POST') {
            const { key } = req.body;
            const data = await redis.get(`license:${key}`);
            if (!data) {
                res.json({ success: false, message: 'Key not found' });
                return;
            }
            
            const lic = JSON.parse(data);
            lic.status = 'revoked';
            await redis.set(`license:${key}`, JSON.stringify(lic));
            res.json({ success: true });
            return;
        }

        // POST /api/reactivate
        if (path === '/api/reactivate' && req.method === 'POST') {
            const { key } = req.body;
            const data = await redis.get(`license:${key}`);
            if (!data) {
                res.json({ success: false, message: 'Key not found' });
                return;
            }
            
            const lic = JSON.parse(data);
            lic.status = 'active';
            await redis.set(`license:${key}`, JSON.stringify(lic));
            res.json({ success: true });
            return;
        }

        // POST /api/delete
        if (path === '/api/delete' && req.method === 'POST') {
            const { key } = req.body;
            await redis.del(`license:${key}`);
            res.json({ success: true });
            return;
        }

        // POST /api/clean
        if (path === '/api/clean' && req.method === 'POST') {
            const keys = await redis.keys('license:*');
            let deleted = 0;
            
            for (const key of keys) {
                const data = await redis.get(key);
                if (data) {
                    const lic = JSON.parse(data);
                    if (lic.status === 'expired') {
                        await redis.del(key);
                        deleted++;
                    }
                }
            }
            
            res.json({ success: true, deleted });
            return;
        }

        res.status(404).json({ error: 'Not found' });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};
