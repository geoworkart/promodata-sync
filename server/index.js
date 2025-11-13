const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// In-memory store for jobs and settings. In a production app, use a database.
let jobs = {};
let jobCounter = 1;
const createJobId = () => `JOB-${String(jobCounter++).padStart(5, '0')}`;
let settings = {
    rules: {
        defaultMargin: 30,
        conditionalRules: [],
    },
    mappings: {
        categories: [],
        fields: [],
    },
    notifications: {
        email: '',
        onSuccess: false,
        onFailure: true,
    },
    advanced: {
        requestsPerMinute: 60,
    }
};


// --- API Endpoints ---

// Settings
app.get('/api/settings', (req, res) => {
    res.status(200).json(settings);
});

app.post('/api/settings', (req, res) => {
    console.log('[Backend] Received settings update:', req.body);
    settings = { ...settings, ...req.body };
    res.status(200).json(settings);
});


// 1. Test WooCommerce Connection
app.post('/api/woo/test', async (req, res) => {
    const { url, key, secret } = req.body;
    console.log('[Backend] Received test connection request for:', url);

    if (!url || !key || !secret) {
        return res.status(400).json({ error: 'Missing WooCommerce credentials.' });
    }

    // Construct the WooCommerce API URL and authentication
    const wooApiUrl = `${url}/wp-json/wc/v3/products?per_page=1`;
    const auth = 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');

    try {
        const response = await fetch(wooApiUrl, {
            headers: { 'Authorization': auth }
        });

        if (!response.ok) {
            let wooError = 'An unknown error occurred.';
            try {
                const errorJson = await response.json();
                wooError = errorJson.message || `WooCommerce API returned status ${response.status}`;
            } catch (e) {
                wooError = `WooCommerce API returned status ${response.status}`;
            }
             console.error('[Backend] Connection test failed:', wooError);
            return res.status(401).json({ error: `Invalid API credentials or URL. WooCommerce said: "${wooError}"` });
        }
        
        console.log('[Backend] WooCommerce connection test successful!');
        res.status(200).json({ success: true });

    } catch (error) {
        console.error('[Backend] Network error during connection test:', error.message);
        res.status(500).json({ error: `Could not connect to the store URL. Ensure the URL is correct and accessible. Error: ${error.message}` });
    }
});

// 2. Start a Sync Job
app.post('/api/woo/start-sync', (req, res) => {
    const { kind, total } = req.body;
    console.log(`[Backend] Received request to start sync job: ${kind} for ${total} items.`);

    const newJob = {
        id: createJobId(),
        kind,
        status: 'queued',
        total: total || 0,
        done: 0,
        started: new Date().toISOString(),
        error: null,
        logs: [], // Initialize logs array
    };

    jobs[newJob.id] = newJob;

    setTimeout(() => {
        if (jobs[newJob.id]) {
            jobs[newJob.id].status = 'running';
            simulateJobProgress(newJob.id);
        }
    }, 2000);
    
    res.status(201).json(newJob);
});


// 3. Get Job Status
app.get('/api/jobs/:id', (req, res) => {
    const { id } = req.params;
    const job = jobs[id];

    if (!job) {
        return res.status(404).json({ error: 'Job not found.' });
    }
    // Return job without the logs
    const { logs, ...jobWithoutLogs } = job;
    res.status(200).json(jobWithoutLogs);
});

// 4. Get Detailed Job Logs
app.get('/api/jobs/:id/logs', (req, res) => {
    const { id } = req.params;
    const job = jobs[id];

    if (!job) {
        return res.status(404).json({ error: 'Job not found.' });
    }

    res.status(200).json(job.logs);
});


// --- Helper for simulating job progress ---
function simulateJobProgress(jobId) {
    const job = jobs[jobId];
    if (!job || job.status !== 'running') return;
    
    const BATCH_SIZE = Math.max(1, Math.floor(job.total / 10)); // Process in ~10 batches
    
    // Simulate processing a batch
    for(let i=0; i<BATCH_SIZE; i++) {
        if (job.done >= job.total) break;
        
        job.done++;
        const shouldFail = Math.random() < 0.05; // 5% chance of failure per item
        
        job.logs.push({
            timestamp: new Date().toISOString(),
            itemId: `P-00${job.done}`,
            status: shouldFail ? 'failed' : 'success',
            message: shouldFail ? `Error: SKU mismatch on update.` : `Synced successfully.`
        });

        if(shouldFail && !job.error) {
            job.error = "One or more items failed to sync.";
        }
    }

    if (job.done >= job.total) {
        job.done = job.total;
        job.status = job.error ? 'failed' : 'completed';
        job.ended = new Date().toISOString();
        console.log(`[Backend] Job ${jobId} finished with status: ${job.status}.`);
    } else {
        // Schedule the next update
        setTimeout(() => simulateJobProgress(jobId), 1500 + Math.random() * 1000);
    }
}


app.listen(PORT, () => {
    console.log(`Backend server listening on port ${PORT}`);
});
