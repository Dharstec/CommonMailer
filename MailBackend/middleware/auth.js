const jwt = require('jsonwebtoken');
require('dotenv').config();
const POSTGRESQLService = require('../helpers/POSTGRES');

/**
 * Admin panel guard.
 *
 * The token is checked against the list stored on the user row as well as being
 * cryptographically verified. That second step is what makes logout real: a
 * stolen but unexpired JWT stops working the moment the session is removed
 * server-side, which signature verification alone cannot give you.
 */
exports.verifyToken = async (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        if (!authHeader) {
            return res.status(403).json({ status: 'error', message: 'No token provided!' });
        }

        const parts = authHeader.split(' ');
        if (parts.length !== 2 || parts[0] !== 'Bearer') {
            return res.status(401).json({
                status: 'error',
                message: "Token format is invalid. Token should be 'Bearer [token]'."
            });
        }

        const token = parts[1];
        const decoded = jwt.verify(token, process.env.SECRET_CODE);

        const result = await POSTGRESQLService.PostgresAny(
            `SELECT id, name, email, role, token, is_active FROM admin_users WHERE id = $1`,
            [decoded.user_id]
        );

        if (!result.length) {
            return res.status(401).json({ status: 'error', message: 'Unauthorized! User not found.' });
        }
        if (!result[0].is_active) {
            return res.status(403).json({ status: 'error', message: 'Account is disabled.' });
        }

        let tokenList = result[0].token || [];
        if (typeof tokenList === 'string') {
            try { tokenList = JSON.parse(tokenList); } catch (e) { tokenList = []; }
        }
        if (!Array.isArray(tokenList) || !tokenList.includes(token)) {
            return res.status(401).json({ status: 'error', message: 'Session expired. Please log in again.' });
        }

        req.user_id = decoded.user_id;
        req.email = decoded.email;
        req.role = result[0].role;
        req.token = token;

        next();
    } catch (err) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized!' });
    }
};

exports.checkRole = (roles) => (req, res, next) => {
    if (!roles.includes(req.role)) {
        return res.status(403).json({ status: 'error', message: 'You do not have permission for this action.' });
    }
    next();
};
