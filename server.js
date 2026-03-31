require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const cors = require('cors');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const DATA_FILE = path.join(__dirname, 'data', 'applications.json');
if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf8');

function readApps() { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch(e) { return []; } }
function writeApps(apps) { fs.writeFileSync(DATA_FILE, JSON.stringify(apps, null, 2), 'utf8'); }
function findApp(googleId) { return readApps().find(a => a.googleId === googleId); }
function findAppById(id) { return readApps().find(a => a.id === id); }
function updateApp(id, updates) {
    const apps = readApps();
    const idx = apps.findIndex(a => a.id === id);
    if (idx === -1) return null;
    Object.assign(apps[idx], updates);
    writeApps(apps);
    return apps[idx];
}

let mailer = null;
try {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_APP_PASSWORD) {
        console.log('[Email] WARNING: EMAIL_USER or EMAIL_APP_PASSWORD not set in .env');
    } else {
        mailer = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASSWORD }
        });
        console.log('[Email] Configured for ' + process.env.EMAIL_USER);
    }
} catch(e) {
    console.error('[Email] Setup failed:', e.message);
}

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { maxAge: 30*24*60*60*1000, httpOnly: true, sameSite: 'lax' } }));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(__dirname));

passport.use(new GoogleStrategy({ clientID: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, callbackURL: process.env.GOOGLE_CALLBACK_URL }, (at, rt, profile, done) => done(null, profile)));
passport.serializeUser((u, d) => d(null, u));
passport.deserializeUser((u, d) => d(null, u));

app.get('/auth/google', passport.authenticate('google', { scope: ['profile','email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/' }), (req, res) => res.redirect(process.env.FRONTEND_URL + '/?logged_in=1'));
app.get('/auth/me', (req, res) => { if (!req.user) return res.status(401).json({ error: 'Not authenticated' }); res.json({ name: req.user.displayName, email: req.user.emails[0].value, googleId: req.user.id, photo: req.user.photos ? req.user.photos[0].value : null }); });
app.get('/auth/logout', (req, res, next) => { req.logout(err => { if (err) return next(err); req.session.destroy(() => res.redirect('/')); }); });

const auth = (req, res, next) => { if (!req.user) return res.status(401).json({ error: 'Auth required' }); next(); };

app.get('/api/application/status', auth, (req, res) => {
    const doc = findApp(req.user.id);
    if (!doc) return res.json({ applied: false });
    res.json({ applied: true, status: doc.status, denyReason: doc.denyReason, submittedAt: doc.submittedAt });
});

app.post('/api/application/submit', auth, (req, res) => {
    try {
        if (findApp(req.user.id)) return res.status(403).json({ error: 'Already applied' });
        const id = 'app_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
        const doc = {
            id, googleId: req.user.id, displayName: req.user.displayName,
            email: req.user.emails[0].value, minecraftName: req.body.minecraftName,
            age: req.body.age, playHistory: req.body.playHistory, skills: req.body.skills,
            pastTeams: req.body.pastTeams, whyJoin: req.body.whyJoin,
            portfolio: req.body.portfolio || '', additional: req.body.additional || '',
            status: 'pending', denyReason: null, discordSent: false,
            submittedAt: new Date().toISOString(), reviewedAt: null
        };
        const apps = readApps();
        apps.push(doc);
        writeApps(apps);
        console.log('[App] New: ' + doc.minecraftName + ' (' + id + ')');
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/application/unsent', (req, res) => { res.json(readApps().filter(a => !a.discordSent)); });
app.post('/api/application/mark-sent', (req, res) => { if (!req.body.id) return res.status(400).json({ error: 'Missing id' }); updateApp(req.body.id, { discordSent: true }); res.json({ success: true }); });

app.get('/api/test-email', async (req, res) => {
    if (!mailer) return res.json({ error: 'Email not configured. Check .env' });
    try {
        await mailer.verify();
        await mailer.sendMail({
            from: '"Minecraft Team" <' + process.env.EMAIL_USER + '>',
            to: process.env.EMAIL_USER,
            subject: 'Test Email - Minecraft Team App',
            html: '<div style="font-family:sans-serif;padding:32px;color:#222"><h2 style="color:#5d9b3a">Email is working!</h2><p>If you see this, notifications work.</p></div>'
        });
        console.log('[Email] Test sent to ' + process.env.EMAIL_USER);
        res.json({ success: true, message: 'Check inbox for ' + process.env.EMAIL_USER });
    } catch(e) {
        console.error('[Email] Test FAILED:', e.message);
        res.json({ error: e.message });
    }
});

app.post('/api/application/decision', async (req, res) => {
    try {
        const { applicationId, status, denyReason } = req.body;
        const doc = findAppById(applicationId);
        if (!doc) return res.status(404).json({ error: 'Not found' });
        if (doc.status !== 'pending') return res.status(400).json({ error: 'Already decided' });
        
        const trimmedDenyReason = typeof denyReason === 'string' ? denyReason.trim() : '';
        updateApp(applicationId, { status: status, denyReason: trimmedDenyReason || null, reviewedAt: new Date().toISOString() });

        if (mailer) {
            var subject, html;

            if (status === 'accepted') {
                subject = 'Welcome to the Team!';
                html = '<div style="font-family:sans-serif;max-width:600px;margin:40px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,0.1);color:#222">'
                    + '<div style="background:linear-gradient(135deg,#5d9b3a,#4a7d2e);padding:30px;text-align:center">'
                    + '<h1 style="color:#fff;margin:0;font-size:26px">Welcome to the Team!</h1>'
                    + '</div>'
                    + '<div style="padding:30px">'
                    + '<p style="font-size:16px;margin-bottom:10px">Hey <strong style="color:#4a7d2e">' + doc.displayName + '</strong>,</p>'
                    + '<p style="font-size:16px;margin:15px 0">Your application has been <strong style="color:#5d9b3a;font-size:18px">ACCEPTED</strong>!</p>'
                    + '<div style="background:#f5f9f3;border-left:4px solid #5d9b3a;padding:15px;border-radius:8px;margin:20px 0">'
                    + '<p style="margin:0;font-size:15px">Minecraft Username: <strong>' + doc.minecraftName + '</strong></p>'
                    + '</div>'
                    + '<p style="font-size:15px">Here Is Our Discord Link You Can Join Us https://discord.gg/8tY2exxS45 </p>'
                    + '<p style="margin-top:25px;font-size:16px">See you in-game!</p>'
                    + '<p style="color:#888;margin-top:30px;font-size:14px">-- The Team</p>'
                    + '</div></div>';
            } else if (status === 'denied' && trimmedDenyReason) {
                subject = 'Your Team Application - Update';
                html = '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#fff;padding:32px;border-radius:12px;color:#222">'
                    + '<div style="background:#333;padding:24px;border-radius:12px 12px 0 0;text-align:center">'
                    + '<h1 style="color:#fff;margin:0">Application Update</h1>'
                    + '</div>'
                    + '<div style="padding:24px">'
                    + '<p>Hey <strong>' + doc.displayName + '</strong>,</p>'
                    + '<p>We decided not to move forward at this time.</p>'
                    + '<div style="background:#fff3f3;border-left:4px solid #ff4757;padding:14px 18px;margin:16px 0;border-radius:0 8px 8px 0">'
                    + '<strong style="color:#ff4757">Feedback:</strong><br>'
                    + '<span style="color:#555">' + trimmedDenyReason.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span>'
                    + '</div>'
                    + '<p>Feel free to apply again in the future.</p>'
                    + '<p style="color:#888;margin-top:24px">-- The Team</p>'
                    + '</div></div>';
            } else {
                subject = 'Your Team Application - Update';
                html = '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#fff;padding:32px;border-radius:12px;color:#222">'
                    + '<div style="background:#333;padding:24px;border-radius:12px 12px 0 0;text-align:center">'
                    + '<h1 style="color:#fff;margin:0">Application Update</h1>'
                    + '</div>'
                    + '<div style="padding:24px">'
                    + '<p>Hey <strong>' + doc.displayName + '</strong>,</p>'
                    + '<p>We reviewed your application and will not move forward this time.</p>'
                    + '<p>Don\'t be discouraged -- apply again in the future.</p>'
                    + '<p style="color:#888;margin-top:24px">-- The Team</p>'
                    + '</div></div>';
            }

            try {
                await mailer.sendMail({
                    from: '"Minecraft Team" <' + process.env.EMAIL_USER + '>',
                    to: doc.email,
                    subject: subject,
                    html: html
                });
                console.log('[Email] SENT ' + status + ' -> ' + doc.email);
            } catch(mailErr) {
                console.error('[Email] FAILED to ' + doc.email + ':', mailErr.message);
            }
        } else {
            console.log('[Email] SKIPPED - not configured');
        }

        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/reset', (req, res) => { writeApps([]); res.json({ reset: true }); });
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(process.env.PORT || 3000, () => console.log('[Server] http://localhost:' + (process.env.PORT || 3000)));