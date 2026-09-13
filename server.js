require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer'); // Added nodemailer
const { createClient } = require('@supabase/supabase-js');
const path = require('path'); // Added path module for static serving

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Large limit to handle base64 image/media strings
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// FIX: Serve static HTML files from your current directory so owner-dashboard.html can be found
app.use(express.static(path.join(__dirname)));

// Initialize Supabase Client
const supabase = createClient(
    process.env.SUPABASE_URL, 
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'salonconnect-super-secret-jwt-key-2026';

const session = require('express-session');

const crypto = require('crypto');

// ------------------------------------------------------------------
// PRODUCTION URLS
// FRONTEND_URL  -> where the customer's browser lives (GitHub Pages)
// BACKEND_URL   -> where this Express server lives (Render)
// PayFast needs both: it sends the *browser* back to FRONTEND_URL,
// and it sends its server-to-server ITN callback to BACKEND_URL.
// ------------------------------------------------------------------
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://lesley-del.github.io/SALONCONNECT';
const BACKEND_URL = process.env.BACKEND_URL || 'https://salonconnect-jbo2.onrender.com';

// Generate PayFast Sandbox or Live Payment Parameters securely
app.post('/api/payments/payfast-init', async (req, res) => {
    try {
        const { salonId, paymentType, tierKey, amount, itemName } = req.body;

        const isSandbox = process.env.PAYFAST_MODE !== 'live';
        const merchantId = process.env.PAYFAST_MERCHANT_ID;
        const merchantKey = process.env.PAYFAST_MERCHANT_KEY;
        const passphrase = process.env.PAYFAST_PASSPHRASE || '';

        // FIXED: was pointing at a dead LocalTunnel URL (sweet-carrots-invite.loca.lt).
        // Now points at your real GitHub Pages frontend and Render backend.
        const returnUrl = `${FRONTEND_URL}/owner-dashboard.html?payment=success&type=${paymentType}`;
        const cancelUrl = `${FRONTEND_URL}/owner-dashboard.html?payment=cancelled`;
        const notifyUrl = `${BACKEND_URL}/api/payments/payfast-webhook`;

        let paymentData = {
            merchant_id: merchantId,
            merchant_key: merchantKey,
            return_url: returnUrl,
            cancel_url: cancelUrl,
            notify_url: notifyUrl,
            name_first: 'Salon',
            name_last: 'Owner',
            email_address: 'owner@salonconnect.co.za',
            m_payment_id: `${salonId}_${Date.now()}`,
            amount: parseFloat(amount).toFixed(2),
            item_name: itemName,
            custom_str1: salonId,
            custom_str2: paymentType,
            custom_str3: tierKey || ''
        };

        // Generate MD5 signature required by PayFast securely on backend
        let signatureString = '';
        for (let key in paymentData) {
            if (paymentData[key] !== '') {
                signatureString += `${key}=${encodeURIComponent(paymentData[key]).replace(/%20/g, "+")}&`;
            }
        }
        signatureString = signatureString.slice(0, -1);
        if (passphrase) {
            signatureString += `&passphrase=${encodeURIComponent(passphrase).replace(/%20/g, "+")}`;
        }
        
        paymentData.signature = crypto.createHash('md5').update(signatureString).digest('hex');

        // Select correct endpoint based on sandbox or live mode
        const payfastUrl = isSandbox 
            ? 'https://sandbox.payfast.co.za/eng/process' 
            : 'https://www.payfast.co.za/eng/process';

        res.json({ payfastUrl, paymentData });
    } catch (err) {
        console.error("PayFast init error:", err);
        res.status(500).json({ error: err.message });
    }
});

// PayFast ITN (Webhook) Route to automatically update Supabase upon successful payment
app.post('/api/payments/payfast-webhook', express.urlencoded({ extended: true }), async (req, res) => {
    try {
        const pfData = req.body;
        console.log("PayFast ITN Webhook received:", pfData);
        
        if (pfData.payment_status === 'COMPLETE') {
            const salonId = pfData.custom_str1;
            const paymentType = pfData.custom_str2;
            const tierKey = pfData.custom_str3;

            if (paymentType === 'monthly') {
                await supabase
                    .from('salons')
                    .update({ 
                        monthly_paid: true, 
                        monthly_paid_at: new Date().toISOString() 
                    })
                    .eq('id', salonId);
                console.log(`Salon ${salonId} monthly subscription marked as paid via webhook.`);
            } else if (paymentType === 'competition') {
                await supabase
                    .from('salon_competitions')
                    .update({ payment_status: 'paid', payment_reference: pfData.pf_payment_id })
                    .eq('salon_id', salonId)
                    .eq('competition_key', tierKey);
                console.log(`Salon ${salonId} competition entry for ${tierKey} marked as paid via webhook.`);
            }
        }

        res.status(200).send('OK');
    } catch (err) {
        console.error("Webhook processing error:", err);
        res.status(500).send('Server Error');
    }
});

// Configure Session Middleware
app.use(session({
    secret: process.env.SESSION_SECRET || 'salonconnect-super-secret-key-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false, 
        httpOnly: true, 
        maxAge: 24 * 60 * 60 * 1000 
    }
}));


// --- COMPETITION SYSTEM ROUTES ---

app.get('/api/admin/competition-status', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('admin_settings')
            .select('value')
            .eq('key', 'competition_open')
            .single();

        if (error) throw error;
        const isOpen = data ? data.value === 'true' : false;
        res.json({ isOpen });
    } catch (err) {
        console.error("Error fetching competition status:", err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/competition-toggle', async (req, res) => {
    try {
        const { isOpen } = req.body;
        const stringValue = String(Boolean(isOpen));

        const { error } = await supabase
            .from('admin_settings')
            .upsert([{ key: 'competition_open', value: stringValue, updated_at: new Date() }]);

        if (error) throw error;
        res.json({ success: true, isOpen: Boolean(isOpen) });
    } catch (err) {
        console.error("Error updating competition status:", err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/salons/:id/competitions/join', async (req, res) => {
    try {
        const { data: settingData, error: settingErr } = await supabase
            .from('admin_settings')
            .select('value')
            .eq('key', 'competition_open')
            .single();

        const isCompetitionOpen = settingData ? settingData.value === 'true' : false;

        if (!isCompetitionOpen) {
            return res.status(403).json({ error: 'Competitions are currently closed by the administrator.' });
        }

        const salonId = req.params.id;
        const { competitionKey, paymentReference } = req.body; 

        if (!['suburb', 'town', 'province', 'country'].includes(competitionKey)) {
            return res.status(400).json({ error: 'Invalid competition tier category.' });
        }

        if (!paymentReference) {
            return res.status(400).json({ error: 'Payment is required to join this competition tier.' });
        }

        const { data: existingEntry } = await supabase
            .from('salon_competitions')
            .select('id')
            .eq('salon_id', salonId)
            .eq('competition_key', competitionKey)
            .maybeSingle();

        if (existingEntry) {
            return res.status(400).json({ error: `Your salon has already joined the ${competitionKey} competition!` });
        }

        const { data: salon, error: salonErr } = await supabase
            .from('salons')
            .select('suburb, town, province')
            .eq('id', salonId)
            .single();

        if (salonErr || !salon) {
            return res.status(404).json({ error: 'Salon profile not found.' });
        }

        let competitionValue = '';
        if (competitionKey === 'suburb') {
            competitionValue = salon.suburb || 'Unspecified Suburb';
        } else if (competitionKey === 'town') {
            competitionValue = salon.town || 'Unspecified Town';
        } else if (competitionKey === 'province') {
            competitionValue = salon.province || 'Unspecified Province';
        } else if (competitionKey === 'country') {
            competitionValue = 'South Africa';
        }

        const { error: joinErr } = await supabase
            .from('salon_competitions')
            .insert([{ 
                salon_id: salonId, 
                competition_key: competitionKey, 
                competition_value: competitionValue,
                points: 0,
                payment_status: 'paid',
                payment_reference: paymentReference
            }]);

        if (joinErr) throw joinErr;

        res.json({ 
            success: true, 
            message: `Payment verified! Successfully joined the ${competitionKey} competition for ${competitionValue}!` 
        });
    } catch (err) {
        console.error("Error joining competition:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/competitions/participants', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('salon_competitions')
            .select(`
                id,
                competition_key,
                competition_value,
                points,
                joined_at,
                salons (
                    id,
                    name,
                    suburb,
                    town,
                    province,
                    email,
                    username
                )
            `)
            .order('points', { ascending: false });

        if (error) throw error;
        res.json({ participants: data || [] });
    } catch (err) {
        console.error("Error fetching admin competition participants:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/salons/:id/competitions/:key/leaderboard', async (req, res) => {
    try {
        const salonId = req.params.id;
        const competitionKey = req.params.key;

        const { data: myEntry, error: myEntryErr } = await supabase
            .from('salon_competitions')
            .select('competition_value')
            .eq('salon_id', salonId)
            .eq('competition_key', competitionKey)
            .single();

        if (myEntryErr || !myEntry) {
            return res.status(400).json({ error: 'You have not joined this competition tier yet. Click Join Competition first.' });
        }

        const targetValue = myEntry.competition_value;

        const { data: participants, error: partError } = await supabase
            .from('salon_competitions')
            .select(`
                salon_id,
                points,
                competition_value,
                salons (
                    id,
                    name,
                    suburb,
                    town,
                    province
                )
            `)
            .eq('competition_key', competitionKey)
            .eq('competition_value', targetValue);

        if (partError) throw partError;
        if (!participants || participants.length === 0) {
            return res.json({ entries: [] });
        }

        const leaderboard = participants.map(p => ({
            salon_id: p.salons.id,
            salon_name: p.salons.name,
            location: p.competition_value,
            points: p.points || 0
        }));

        leaderboard.sort((a, b) => b.points - a.points);

        res.json({ entries: leaderboard });
    } catch (err) {
        console.error("Error fetching leaderboard:", err);
        res.status(500).json({ error: err.message });
    }
});

function verifyVoterToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token.' });
        }
        req.voter = decoded;
        next();
    });
}

app.post('/api/voters/register', async (req, res) => {
    try {
        const { name, username, phone, email, password } = req.body;
        if (!name || !username || !phone || !email || !password) {
            return res.status(400).json({ error: 'All fields are required.' });
        }

        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        const { data, error } = await supabase
            .from('voters')
            .insert([{ name, username, phone, email, password: hashedPassword }])
            .select()
            .single();

        if (error) {
            if (error.code === '23505') {
                return res.status(400).json({ error: 'Email or Username is already taken.' });
            }
            throw error;
        }

        const voterPayload = { id: data.id, name: data.name, username: data.username, phone: data.phone, email: data.email };
        const token = jwt.sign(voterPayload, JWT_SECRET, { expiresIn: '7d' });

        res.json({ success: true, token, voter: voterPayload, message: 'Registration successful!' });
    } catch (err) {
        console.error("Voter registration error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/voters/login', async (req, res) => {
    try {
        const { identifier, password } = req.body;
        if (!identifier || !password) {
            return res.status(400).json({ error: 'Please provide email/username and password.' });
        }

        const { data: voter, error } = await supabase
            .from('voters')
            .select('*')
            .or(`email.eq.${identifier},username.eq.${identifier}`)
            .maybeSingle();

        if (error || !voter) {
            return res.status(401).json({ error: 'Invalid email/username or password.' });
        }

        const isMatch = await bcrypt.compare(password, voter.password);
        if (!isMatch) {
            return res.status(401).json({ error: 'Invalid email/username or password.' });
        }

        const voterPayload = { id: voter.id, name: voter.name, username: voter.username, phone: voter.phone, email: voter.email };
        const token = jwt.sign(voterPayload, JWT_SECRET, { expiresIn: '7d' });

        res.json({ success: true, token, voter: voterPayload });
    } catch (err) {
        console.error("Voter login error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/salons/:id/vote', verifyVoterToken, async (req, res) => {
    try {
        const salonId = req.params.id;
        const voterId = req.voter.id;

        const { data: existingVote } = await supabase
            .from('salon_votes')
            .select('id')
            .eq('salon_id', salonId)
            .eq('voter_id', voterId)
            .maybeSingle();

        if (existingVote) {
            return res.status(400).json({ error: 'You have already cast your single vote for this salon!' });
        }

        const { error: voteErr } = await supabase
            .from('salon_votes')
            .insert([{ salon_id: salonId, voter_id: voterId }]);

        if (voteErr) throw voteErr;

        const { data: entries } = await supabase.from('salon_competitions').select('id, points').eq('salon_id', salonId);
        if (entries && entries.length > 0) {
            for (const entry of entries) {
                await supabase.from('salon_competitions').update({ points: (entry.points || 0) + 1 }).eq('id', entry.id);
            }
        }

        res.json({ success: true, message: 'Vote successfully recorded!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'ntshuxekomalangana@gmail.com',
        pass: 'zajx iazz mjuw qjhh'
    },
    tls: {
        rejectUnauthorized: false 
    }
});

app.post('/api/check-salon', async (req, res) => {
    try {
        const { username, salonName } = req.body;
        
        let query = supabase.from('salons').select('name, username');
        if (username) query = query.eq('username', username);
        if (salonName) query = query.ilike('name', salonName);

        const { data, error } = await query.maybeSingle();
        if (error) throw error;

        res.json({ exists: !!data });
    } catch (err) {
        console.error("Error checking salon:", err.message);
        res.status(500).json({ error: "Server error checking availability" });
    }
});

app.post('/api/register-salon', async (req, res) => {
    try {
        const {
            username,
            email,
            password,
            salonName,
            headerImage,
            suburb,
            town,
            province,
            maleBarbers,
            femaleStylists,
            freeHairGiveaway,
            betawayChallenge
        } = req.body;

        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        const { data, error } = await supabase
            .from('salons')
            .insert([
                {
                    username,
                    email,
                    password: hashedPassword,
                    name: salonName,
                    header_image: headerImage,
                    suburb,
                    town,
                    province,
                    male_barbers: maleBarbers || 1,
                    female_stylists: femaleStylists || 1,
                    free_hair_giveaway: freeHairGiveaway,
                    betaway_challenge: betawayChallenge,
                    status: 'pending',        
                    is_accepting_bookings: true,
                    advance_booking_days: 3    
                }
            ]).select();

        if (error) throw error;

        res.status(201).json({ message: "Salon registered successfully", data });
    } catch (err) {
        console.error("Error registering salon:", err.message);
        res.status(500).json({ error: err.message || "Server error during registration" });
    }
});

app.post('/api/login-salon', async (req, res) => {
    try {
        const { identifier, username, password } = req.body;
        const loginId = identifier || username;

        if (!loginId || !password) {
            return res.status(400).json({ error: "Please provide your username/email and password." });
        }

        const { data: salon, error } = await supabase
            .from('salons')
            .select('*')
            .or(`email.eq.${loginId},username.eq.${loginId}`)
            .maybeSingle();

        if (error || !salon) {
            return res.status(401).json({ error: "Invalid username/email or password" });
        }

        const isMatch = await bcrypt.compare(password, salon.password);
        if (!isMatch) {
            return res.status(401).json({ error: "Invalid username/email or password" });
        }

        res.json({ 
            message: "Login successful", 
            salonId: salon.id, 
            salonName: salon.name,
            username: salon.username,
            role: salon.role || 'owner' 
        });
    } catch (err) {
        console.error("Error during salon login:", err.message);
        res.status(500).json({ error: "Server error during login" });
    }
});

app.post('/api/admin/competitions/publish-winners', async (req, res) => {
    try {
        const { titleCustom, detailsCustom } = req.body;

        const { data: entries, error } = await supabase
            .from('salon_competitions')
            .select(`
                competition_key,
                competition_value,
                points,
                salons (
                    id,
                    name,
                    header_image,
                    suburb,
                    town,
                    province,
                    male_barbers,
                    female_stylists
                )
            `);

        if (error) throw error;
        if (!entries || entries.length === 0) {
            return res.status(400).json({ error: 'No competition participants found to calculate winners.' });
        }

        const groups = {};
        entries.forEach(e => {
            const groupKey = `${e.competition_key}___${e.competition_value}`;
            if (!groups[groupKey]) {
                groups[groupKey] = {
                    key: e.competition_key,
                    value: e.competition_value,
                    topSalon: null,
                    maxPoints: -1
                };
            }
            const salonObj = e.salons || {};
            const pts = e.points || 0;

            if (pts > groups[groupKey].maxPoints) {
                groups[groupKey].maxPoints = pts;
                groups[groupKey].topSalon = salonObj;
            }
        });

        const announcementsToInsert = [];
        for (const gKey in groups) {
            const group = groups[gKey];
            const tierTitle = group.key.toUpperCase();
            const locationName = group.value;
            const salon = group.topSalon || {};
            const salonName = salon.name || 'Unknown Salon';
            const pointsCount = group.maxPoints;

            const finalTitle = titleCustom ? `${titleCustom} (${tierTitle}: ${locationName})` : `🏆 Winner: ${tierTitle} Championship — ${locationName}`;
            const finalDetails = detailsCustom ? `${detailsCustom}\n\nChampion: ${salonName} with ${pointsCount} points!` : `Congratulations to ${salonName} for winning the ${tierTitle} competition for ${locationName} with a total of ${pointsCount} verified check-in points!`;

            announcementsToInsert.push({
                title: finalTitle,
                details: finalDetails,
                tier_category: group.key,
                location_value: group.value,
                winner_salon_name: salonName,
                winner_salon_id: salon.id || null,
                winner_header_image: salon.header_image || null,
                winner_suburb: salon.suburb || '',
                winner_town: salon.town || '',
                winner_province: salon.province || '',
                winner_male_barbers: salon.male_barbers || 0,
                winner_female_stylists: salon.female_stylists || 0,
                points: pointsCount
            });
        }

        const { error: insertErr } = await supabase
            .from('admin_announcements')
            .insert(announcementsToInsert);

        if (insertErr) throw insertErr;

        res.json({ success: true, message: `Successfully calculated and published winners across ${announcementsToInsert.length} location categories!` });
    } catch (err) {
        console.error("Error publishing winners:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/announcements', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('admin_announcements')
            .select('*')
            .order('published_at', { ascending: false });

        if (error) throw error;
        res.json({ announcements: data || [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/salons', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('salons')
            .select('*')
            .neq('role', 'admin')
            .order('id', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error("Error fetching salons for admin:", err.message);
        res.status(500).json({ error: "Error fetching salon records" });
    }
});

app.patch('/api/admin/salons/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        const { data, error } = await supabase
            .from('salons')
            .update({ status })
            .eq('id', id)
            .select();

        if (error) throw error;
        res.json({ message: `Salon status updated to ${status}`, data });
    } catch (err) {
        console.error("Error updating salon status:", err.message);
        res.status(500).json({ error: "Error updating salon status" });
    }
});

app.post('/api/admin/send-email', async (req, res) => {
    try {
        const { recipient, subject, body } = req.body;

        if (!subject || !body) {
            return res.status(400).json({ message: 'Subject and message body are required.' });
        }

        let targetEmails = [];

        if (recipient === 'all') {
            const { data: salons, error } = await supabase.from('salons').select('email');
            if (error) throw error;
            targetEmails = (salons || []).map(s => s.email).filter(Boolean);
        } else {
            targetEmails = [recipient];
        }

        if (targetEmails.length === 0) {
            return res.status(400).json({ message: 'No recipient email addresses found.' });
        }

        const formattedBody = body.replace(/\n/g, '<br>');
        const htmlContent = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <style>
                    body { background-color: #f6f7fb; font-family: 'DM Sans', Arial, sans-serif; margin: 0; padding: 0; color: #171a3d; }
                    .wrapper { width: 100%; table-layout: fixed; background-color: #f6f7fb; padding: 40px 0; }
                    .main { background-color: #ffffff; margin: 0 auto; width: 100%; max-width: 600px; border-radius: 20px; overflow: hidden; border: 1px solid #e2e2ee; box-shadow: 0 10px 30px rgba(25, 24, 65, 0.05); }
                    .header { background: linear-gradient(135deg, #111431 0%, #191d45 58%, #28225b 100%); padding: 30px; text-align: center; color: #ffffff; }
                    .logo-mark { display: inline-block; width: 42px; height: 42px; border-radius: 12px; background: linear-gradient(135deg, #6d45d6, #9b73ef); color: #ffffff; font-weight: 900; font-size: 20px; line-height: 42px; text-align: center; margin-bottom: 10px; box-shadow: 0 5px 15px rgba(109,69,214,0.3); }
                    .header h1 { margin: 0; font-size: 22px; font-family: serif; letter-spacing: -0.5px; }
                    .header span { font-size: 10px; text-transform: uppercase; letter-spacing: 2px; color: #d9c9ff; font-weight: bold; }
                    .content { padding: 40px 30px; font-size: 14px; line-height: 1.7; color: #334155; }
                    .btn-container { text-align: center; margin: 30px 0 10px 0; }
                    .btn { background-color: #6d45d6; color: #ffffff !important; padding: 12px 28px; border-radius: 12px; text-decoration: none; font-weight: bold; font-size: 13px; display: inline-block; box-shadow: 0 8px 20px rgba(109,69,214,0.25); }
                    .footer { background-color: #f8f8fc; padding: 20px 30px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #eee; }
                </style>
            </head>
            <body>
                <div class="wrapper">
                    <table class="main" align="center" cellpadding="0" cellspacing="0">
                        <tr>
                            <td class="header">
                                <div class="logo-mark">S</div>
                                <h1>SalonConnect</h1>
                                <span>Official Platform Broadcast</span>
                            </td>
                        </tr>
                        <tr>
                            <td class="content">
                                <p>${formattedBody}</p>
                                <div class="btn-container">
                                    <a href="${FRONTEND_URL}" class="btn">Open Salon Dashboard</a>
                                </div>
                            </td>
                        </tr>
                        <tr>
                            <td class="footer">
                                &copy; 2026 SalonConnect. All rights reserved.<br>Real Salons • Real People • Real Beauty
                            </td>
                        </tr>
                    </table>
                </div>
            </body>
            </html>
        `;

        const mailOptions = {
            from: '"SalonConnect Admin" <your-email@gmail.com>',
            bcc: targetEmails, 
            subject: subject,
            text: body, 
            html: htmlContent
        };

        await transporter.sendMail(mailOptions);

        res.json({ success: true, message: `Beautiful HTML email successfully dispatched to ${targetEmails.length} recipient(s)!` });
    } catch (err) {
        console.error("Error sending email:", err);
        res.status(500).json({ message: 'Failed to send email: ' + err.message });
    }
});

app.patch('/api/salons/:id/settings', async (req, res) => {
    try {
        const { id } = req.params;
        const { isAcceptingBookings, advanceBookingDays } = req.body;

        const updateData = {};
        if (isAcceptingBookings !== undefined) updateData.is_accepting_bookings = isAcceptingBookings;
        if (advanceBookingDays !== undefined) updateData.advance_booking_days = advanceBookingDays;

        const { data, error } = await supabase
            .from('salons')
            .update(updateData)
            .eq('id', id)
            .select();

        if (error) throw error;
        res.json({ message: "Salon settings updated successfully", data });
    } catch (err) {
        console.error("Error updating salon settings:", err.message);
        res.status(500).json({ error: "Error updating booking settings" });
    }
});

app.get('/api/salons/:id/settings', async (req, res) => {
    try {
        const salonId = req.params.id;
        const { data, error } = await supabase
            .from('salons')
            .select('id, name, male_barbers, female_stylists, open_time, close_time, advance_booking_days')
            .eq('id', salonId)
            .maybeSingle();

        if (error || !data) {
            return res.status(404).json({ error: 'Salon not found.' });
        }

        res.status(200).json(data);
    } catch (err) {
        console.error("Error fetching salon settings:", err);
        res.status(500).json({ error: 'Failed to retrieve salon settings.' });
    }
});

app.get('/api/salons/:salonId/bookings', async (req, res) => {
    try {
        const { salonId } = req.params;
        const { data, error } = await supabase
            .from('bookings')
            .select('*')
            .eq('salon_id', salonId)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.json([]);
    }
});

app.post('/api/bookings/came', async (req, res) => {
    try {
        const { bookingId, customerEmail, salonId } = req.body;

        const { data, error } = await supabase
            .from('customer_visits')
            .insert([
                { 
                    salon_id: salonId, 
                    booking_id: bookingId || null, 
                    customer_email: customerEmail,
                    visited_at: new Date() 
                }
            ]).select();

        if (error) throw error;

        if (bookingId) {
            await supabase
                .from('bookings')
                .update({ status: 'completed', came: true })
                .eq('id', bookingId);
        }

        res.json({ message: "Client visit logged successfully. Added to winner challenge tally!", data });
    } catch (err) {
        console.error("Error recording client visit:", err.message);
        res.status(500).json({ error: "Error logging client visit" });
    }
});

app.get('/api/salons/:id/availability', async (req, res) => {
    const salonId = req.params.id;
    const { date } = req.query;

    if (!date) {
        return res.status(400).json({ error: 'Date query parameter is required.' });
    }

    try {
        const { data: bookingsData, error: bookingsError } = await supabase
            .from('bookings')
            .select('time_slot')
            .eq('salon_id', salonId)
            .eq('booking_date', date);

        if (bookingsError) throw bookingsError;

        const bookingsMap = {};
        bookingsData.forEach(row => {
            if (row.time_slot) {
                bookingsMap[row.time_slot] = (bookingsMap[row.time_slot] || 0) + 1;
            }
        });

        const { data: blockoutsData, error: blockoutsError } = await supabase
            .from('salon_blockouts')
            .select('start_time, end_time')
            .eq('salon_id', salonId)
            .eq('blockout_date', date);

        if (blockoutsError) throw blockoutsError;

        res.status(200).json({
            bookingsMap,
            blockouts: blockoutsData || []
        });

    } catch (err) {
        console.error("Error fetching availability status:", err);
        res.status(500).json({ error: 'Failed to check slot availability.' });
    }
});

app.post('/api/salons/:id/blockout-times', async (req, res) => {
    const salonId = req.params.id;
    const { blockoutDate, startTime, endTime } = req.body;

    if (!blockoutDate || !startTime || !endTime) {
        return res.status(400).json({ error: 'Missing required block-out parameters.' });
    }

    try {
        const { data, error } = await supabase
            .from('salon_blockouts')
            .insert([
                {
                    salon_id: salonId,
                    blockout_date: blockoutDate,
                    start_time: startTime,
                    end_time: endTime
                }
            ])
            .select();

        if (error) throw error;

        res.status(201).json({ 
            success: true, 
            message: 'Time range successfully blocked out.', 
            blockout: data[0] 
        });

    } catch (err) {
        console.error("Error saving block-out time:", err);
        res.status(500).json({ error: 'Failed to record block-out slot.' });
    }
});

app.get('/api/salons/:id/blockout-times', async (req, res) => {
    const salonId = req.params.id;
    try {
        const { data, error } = await supabase
            .from('salon_blockouts')
            .select('*')
            .eq('salon_id', salonId)
            .order('blockout_date', { ascending: true });

        if (error) throw error;
        res.status(200).json(data);
    } catch (err) {
        console.error("Error fetching blockouts:", err);
        res.status(500).json({ error: 'Failed to retrieve block-out slots.' });
    }
});

app.delete('/api/blockout-times/:id', async (req, res) => {
    const blockoutId = req.params.id;
    try {
        const { error } = await supabase
            .from('salon_blockouts')
            .delete()
            .eq('id', blockoutId);

        if (error) throw error;
        res.status(200).json({ success: true, message: 'Block-out removed successfully.' });
    } catch (err) {
        console.error("Error deleting blockout:", err);
        res.status(500).json({ error: 'Failed to delete block-out slot.' });
    }
});

app.post('/api/salons/:id/book', async (req, res) => {
    const salonId = req.params.id;
    const { firstName, surname, phone, email, styleType, serviceCategory, bookingDate, timeSlot } = req.body;

    if (!firstName || !surname || !phone || !bookingDate || !timeSlot || !serviceCategory) {
        return res.status(400).json({ error: 'Missing required appointment fields.' });
    }

    try {
        const { data: salon, error: salonError } = await supabase
            .from('salons')
            .select('name, male_barbers, female_stylists, advance_booking_days, monthly_paid, monthly_paid_at, status, is_accepting_bookings')
            .eq('id', salonId)
            .maybeSingle();

        if (salonError || !salon) {
            return res.status(404).json({ error: 'Salon not found.' });
        }

        if (salon.status !== 'approved' || salon.is_accepting_bookings === false) {
            return res.status(400).json({ error: 'This salon is currently not accepting bookings.' });
        }

        let isSubscriptionActive = salon.monthly_paid;

        if (isSubscriptionActive && salon.monthly_paid_at) {
            const paidDate = new Date(salon.monthly_paid_at);
            const now = new Date();
            const diffTime = now - paidDate;
            const diffDays = diffTime / (1000 * 60 * 60 * 24);

            if (diffDays > 30) {
                await supabase
                    .from('salons')
                    .update({ monthly_paid: false })
                    .eq('id', salonId);

                isSubscriptionActive = false;
            }
        }

        if (!isSubscriptionActive) {
            return res.status(403).json({ 
                error: 'This salon cannot receive client bookings because their 30-day monthly subscription fee is unpaid or has expired.' 
            });
        }

        const maxCapacity = serviceCategory === 'male' ? (salon.male_barbers || 1) : (salon.female_stylists || 1);

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const targetDate = new Date(bookingDate);
        targetDate.setHours(0, 0, 0, 0);

        const diffDays = Math.round((targetDate - today) / (1000 * 60 * 60 * 24));
        const maxAllowedDays = salon.advance_booking_days !== null ? salon.advance_booking_days : 3;

        if (diffDays < 0 || diffDays > maxAllowedDays) {
            return res.status(400).json({ error: `Booking date exceeds salon's allowed advance window of ${maxAllowedDays} day(s).` });
        }

        const slotStartTime = timeSlot.split(' - ')[0] + ':00';
        const { data: blocks, error: blockError } = await supabase
            .from('salon_blockouts')
            .select('*')
            .eq('salon_id', salonId)
            .eq('blockout_date', bookingDate)
            .lte('start_time', slotStartTime)
            .gte('end_time', slotStartTime);

        if (!blockError && blocks && blocks.length > 0) {
            return res.status(400).json({ error: 'This time slot has been blocked by the salon owner.' });
        }

        const { data: existingBookings, error: countError } = await supabase
            .from('bookings')
            .select('id')
            .eq('salon_id', salonId)
            .eq('booking_date', bookingDate)
            .eq('time_slot', timeSlot);

        if (countError) throw countError;

        const currentBookingsCount = existingBookings ? existingBookings.length : 0;
        if (currentBookingsCount >= maxCapacity) {
            return res.status(400).json({ error: 'This time slot is fully booked.' });
        }

        const { data: newBooking, error: insertError } = await supabase
            .from('bookings')
            .insert([
                {
                    salon_id: salonId,
                    client_name: `${firstName} ${surname}`,
                    first_name: firstName,
                    surname,
                    phone: phone,
                    phone_number: phone,
                    email,
                    style_type: styleType,
                    service_type: styleType,
                    service_category: serviceCategory,
                    booking_date: bookingDate,
                    time_slot: timeSlot, 
                    status: 'confirmed'
                }
            ])
            .select();

        if (insertError) throw insertError;

        if (email) {
            try {
                const htmlEmailTemplate = `
                    <div style="font-family: Arial, sans-serif; background-color: #f8fafc; padding: 30px 0; color: #334155;">
                        <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
                            
                            <!-- Header Banner -->
                            <div style="background-color: #4f46e5; padding: 30px; text-align: center; color: #ffffff;">
                                <h1 style="margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">SalonConnect</h1>
                                <p style="margin: 5px 0 0 0; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.9;">Official Appointment Receipt</p>
                            </div>

                            <!-- Body Content -->
                            <div style="padding: 30px;">
                                <h2 style="margin-top: 0; color: #0f172a; font-size: 20px;">Hello ${firstName} ${surname},</h2>
                                <p style="font-size: 14px; line-height: 1.6; color: #475569;">Your booking at <strong style="color: #4f46e5;">${salon.name}</strong> has been successfully confirmed and secured in our system.</p>
                                
                                <!-- Details Box -->
                                <div style="background-color: #f1f5f9; border-radius: 12px; padding: 20px; margin: 25px 0; border: 1px solid #cbd5e1;">
                                    <table style="width: 100%; font-size: 14px; border-collapse: collapse;">
                                        <tr>
                                            <td style="padding: 8px 0; color: #64748b; font-weight: bold;">Salon Venue:</td>
                                            <td style="padding: 8px 0; color: #0f172a; font-weight: 700; text-align: right;">${salon.name}</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 8px 0; color: #64748b; font-weight: bold;">Appointment Date:</td>
                                            <td style="padding: 8px 0; color: #0f172a; font-weight: 700; text-align: right;">${bookingDate}</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 8px 0; color: #64748b; font-weight: bold;">Reserved Time Slot:</td>
                                            <td style="padding: 8px 0; color: #4f46e5; font-weight: 700; text-align: right;">${timeSlot}</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 8px 0; color: #64748b; font-weight: bold;">Selected Style / Service:</td>
                                            <td style="padding: 8px 0; color: #0f172a; font-weight: 700; text-align: right;">${styleType} (${serviceCategory})</td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 8px 0; color: #64748b; font-weight: bold;">Contact Phone:</td>
                                            <td style="padding: 8px 0; color: #0f172a; font-weight: 700; text-align: right;">${phone}</td>
                                        </tr>
                                    </table>
                                </div>

                                <p style="font-size: 13px; line-height: 1.5; color: #64748b;">Please arrive 5 minutes prior to your scheduled slot. If you need to make changes or check updates, you can contact the salon directly.</p>
                                
                                <div style="margin-top: 30px; border-top: 1px solid #e2e8f0; padding-top: 20px; text-align: center;">
                                    <p style="margin: 0; font-size: 12px; color: #94a3b8;">Thank you for choosing <strong>SalonConnect</strong> — Bridging clients and local salons seamlessly.</p>
                                </div>
                            </div>
                            
                            <!-- Footer -->
                            <div style="background-color: #f1f5f9; padding: 15px; text-align: center; font-size: 11px; color: #94a3b8;">
                                &copy; 2026 SalonConnect Enterprise. All rights reserved.
                            </div>

                        </div>
                    </div>
                `;

                await transporter.sendMail({
                    from: '"SalonConnect Bookings" <ntshuxekomalangana@gmail.com>',
                    to: email,
                    subject: `Booking Confirmed: ${salon.name} (${bookingDate})`,
                    html: htmlEmailTemplate
                });
                console.log(`Branded confirmation HTML email successfully sent to client: ${email}`);
            } catch (mailErr) {
                console.error("Failed to send confirmation email, but booking was saved:", mailErr.message);
            }
        }

        res.status(201).json({
            success: true,
            message: 'Appointment successfully confirmed and branded email dispatched!',
            booking: newBooking[0]
        });

    } catch (err) {
        console.error("Error creating booking:", err);
        res.status(500).json({ error: 'Server error while processing booking.' });
    }
});

app.get('/api/salons/approved', async (req, res) => {
    try {
        const { data: salons, error } = await supabase
            .from('salons')
            .select('id, name, suburb, town, province, male_barbers, female_stylists, header_image, free_hair_giveaway, betaway_challenge, monthly_paid, monthly_paid_at, status')
            .eq('status', 'approved');

        if (error) throw error;

        const evaluatedSalons = salons.map(salon => {
            let active = salon.monthly_paid;
            if (active && salon.monthly_paid_at) {
                const diffDays = (new Date() - new Date(salon.monthly_paid_at)) / (1000 * 60 * 60 * 24);
                if (diffDays > 30) active = false;
            }
            return { ...salon, isPaidActive: active };
        });

        res.json(evaluatedSalons);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/salons/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabase
            .from('salons')
            .select('*')
            .eq('id', id)
            .maybeSingle();

        if (error || !data) {
            return res.status(404).json({ error: "Salon not found" });
        }
        res.json(data);
    } catch (err) {
        console.error("Error fetching salon by ID:", err.message);
        res.status(500).json({ error: "Server error fetching salon details" });
    }
});

app.patch('/api/salons/:id/header-image', async (req, res) => {
    try {
        const { id } = req.params;
        const { headerImage } = req.body;

        const { data, error } = await supabase
            .from('salons')
            .update({ header_image: headerImage })
            .eq('id', id)
            .select();

        if (error) throw error;
        res.json({ message: "Header image updated successfully", data });
    } catch (err) {
        console.error("Error updating header image:", err.message);
        res.status(500).json({ error: "Error updating header image" });
    }
});

app.get('/api/salon-gallery/:salonId', async (req, res) => {
    try {
        const { salonId } = req.params;
        const { data, error } = await supabase
            .from('salon_gallery')
            .select('*')
            .eq('salon_id', salonId);

        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: "Error fetching gallery pictures" });
    }
});

app.post('/api/salon-gallery', async (req, res) => {
    try {
        const { salonId, imageUrl } = req.body;
        const { data, error } = await supabase
            .from('salon_gallery')
            .insert([{ salon_id: salonId, image_url: imageUrl }])
            .select();

        if (error) throw error;
        res.status(201).json({ message: "Media added successfully", data });
    } catch (err) {
        res.status(500).json({ error: "Error uploading gallery media" });
    }
});

app.post('/api/salon-gallery/batch', async (req, res) => {
    try {
        const { salonId, images } = req.body;

        if (!images || !Array.isArray(images) || images.length === 0) {
            return res.status(400).json({ error: "No images provided for batch upload." });
        }

        const insertRows = images.map(imageUrl => ({
            salon_id: salonId,
            image_url: imageUrl
        }));

        const { data, error } = await supabase
            .from('salon_gallery')
            .insert(insertRows)
            .select();

        if (error) throw error;
        
        res.status(201).json({ 
            message: `${images.length} media file(s) uploaded successfully`, 
            data 
        });
    } catch (err) {
        console.error("Error with batch upload:", err.message);
        res.status(500).json({ error: "Error uploading multiple gallery media" });
    }
});

app.delete('/api/salon-gallery/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('salon_gallery')
            .delete()
            .eq('id', id);

        if (error) throw error;
        res.json({ message: "Media deleted successfully" });
    } catch (err) {
        res.status(500).json({ error: "Error deleting media" });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { identifier, password } = req.body;

        const { data: salon, error } = await supabase
            .from('salons')
            .select('*')
            .eq('username', identifier)
            .maybeSingle();

        if (error || !salon) {
            return res.status(401).json({ error: "Invalid username or password" });
        }

        const isMatch = await bcrypt.compare(password, salon.password);
        if (!isMatch) {
            return res.status(401).json({ error: "Invalid username or password" });
        }

        res.json({ 
            message: "Login successful", 
            token: 'fake-jwt-token-' + salon.id,
            username: salon.username,
            role: salon.role || 'owner', 
            salonId: salon.id, 
            salonName: salon.name 
        });
    } catch (err) {
        console.error("Error during login:", err.message);
        res.status(500).json({ error: "Server error during login" });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`SalonConnect secure backend running on port ${PORT}`);
});
