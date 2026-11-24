'use strict';

const { readOpenedFile } = require('./filesystem-boundary');

function invalidCatalogError() {
  const error = new Error('governed catalog JSON is invalid');
  error.code = 'FACTORY_CATALOG_JSON_INVALID';
  return error;
}

function loadCatalogRecord(root, relativePath, options = {}) {
  const opened = readOpenedFile(root, relativePath, options);
  let document;
  try {
    document = JSON.parse(opened.buffer.toString('utf8'));
  } catch {
    throw invalidCatalogError();
  }
  return { document, contentDigest: opened.contentDigest };
}

function loadCatalog(root, relativePath, options = {}) {
  return loadCatalogRecord(root, relativePath, options).document;
}

module.exports = { loadCatalog, loadCatalogRecord };
