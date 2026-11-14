'use strict';
// node config-get.js ports.relay  -> prints one config value (used by the bash wrappers in bin/).
const { load } = require('./kitconfig');
const v = process.argv[2].split('.').reduce((o, k) => (o == null ? o : o[k]), load());
if (v != null) console.log(typeof v === 'object' ? JSON.stringify(v) : v);
