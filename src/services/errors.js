'use strict';
const err = (status, msg) => { const e = new Error(msg); e.status = status; return e; };
module.exports = { bad: m => err(400, m), notFound: m => err(404, m || 'Not found'), conflict: m => err(409, m), err };
