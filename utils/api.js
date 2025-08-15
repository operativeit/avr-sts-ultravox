const axios = require('axios');
const { localStorage } = require('./storage');

require('dotenv').config();

const instance = axios.create({
  crossDomain: true,
  baseURL: process.env.API_URL,
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
});

instance.defaults.timeout = 10000;
instance.interceptors.request.use(
  (config) => {
    const auth = localStorage.get('auth');
    if (auth?.success) {
      config.headers['Authorization'] = 'Bearer ' + auth.authorization.token;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  },
);

instance.interceptors.response.use(
  (response) => {
    return response;
  },
  (error) => {
    console.log('error:', error.response.status);
    if ([401, 403].includes(error.response.status)) {
      localStorage.remove('auth');
      return;
    } else {
      return Promise.reject(error);
    }
  },
);

module.exports = instance;
