module.exports = {
  plans: {
    processed: new Set(), // stores processed references to avoid double-grants
  },
};
