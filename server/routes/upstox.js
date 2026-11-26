import { Router } from 'express';
import { verifyConfiguration } from '../middleware/upstox.js';
import { saveAccessToken, loadAccessToken, clearAccessToken } from '../service/tokenStore.js';
import { getAuthURL, getAccessTokenFromCode, getUserProfile } from '../service/upstox.js';

export const router = Router();

router.use(verifyConfiguration);

router.get("/login", (req, res) => {
    console.log("LOGIN BEGINS");
    const url = getAuthURL(req.query.state);
    console.log(url);
    res.redirect(url);
});
        
router.get("/callback", async (req, res) => {
    const code = req.query.code;
    const err = req.query.error;

    if (err) {
        return res.redirect(`/?error=${encodeURIComponent(err)}`);
    }

    if (!code || typeof code !== "string") {
        return res.redirect(`/?error=${encodeURIComponent("missing_code")}`);
    }

    try {
        const token = await getAccessTokenFromCode(code);
        await saveAccessToken(token);
        return res.redirect(`http://localhost:5173`);
    } catch (e) {
        return res.redirect(`/?error=${encodeURIComponent(e.message)}`);
    }
})
