import { Router } from 'express';
import { verifyConfiguration } from '../middleware/upstox.js';
import { saveAccessToken } from '../service/tokenStore.js';
import { getAuthURL, getAccessTokenFromCode } from '../service/upstox.js';

export const router = Router();

router.use(verifyConfiguration);

router.get("/login", (req, res) => {
    res.redirect(getAuthURL(req.query.state));
});

router.get("/callback", async (req, res) => {
    const { code, error } = req.query;
    const fail = (reason) => res.redirect(`/?error=${encodeURIComponent(reason)}`);

    if (error) {
        return fail(error);
    }

    if (!code || typeof code !== "string") {
        return fail("missing_code");
    }

    try {
        await saveAccessToken(await getAccessTokenFromCode(code));
        return res.redirect("/");
    } catch (e) {
        return fail(e.message);
    }
});
