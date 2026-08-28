module.exports = {
  apps: [
    {
      name: 'ai_cord_account1',
      script: 'src/index.js',
      watch: false,
      env: {
        NODE_ENV: 'production',
        MULTI_ACCOUNT_MODE: 'true'
      },
      error_file: 'logs/account1-error.log',
      out_file: 'logs/account1-out.log',
      log_file: 'logs/account1-combined.log',
      time: true
    },
    {
      name: 'ai_cord_account2',
      script: 'src/index.js',
      watch: false,
      env: {
        NODE_ENV: 'production',
        MULTI_ACCOUNT_MODE: 'true'
      },
      error_file: 'logs/account2-error.log',
      out_file: 'logs/account2-out.log',
      log_file: 'logs/account2-combined.log',
      time: true
    }
  ]
};
