import Busboy from 'busboy';
import { AppError } from './errors.js';

export function readMultipart(req, { maxBytes, maxFields = 8, maxFiles = 1, maxParts = maxFields + maxFiles, allowedFields }) {
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({ headers: req.headers, limits: { fileSize: maxBytes, files: maxFiles, fields: maxFields, parts: maxParts + 1 } });
    } catch {
      reject(AppError.badRequest('multipart_invalid', 'The uploaded form is malformed.'));
      return;
    }
    const fields = {};
    const files = [];
    let tooLarge = false;
    let malformed = false;
    parser.on('file', (fieldName, stream, info) => {
      if (files.length >= maxFiles || fieldName !== 'file') {
        malformed = true;
        stream.resume();
        return;
      }
      const chunks = [];
      stream.on('limit', () => { tooLarge = true; });
      stream.on('data', (chunk) => chunks.push(chunk));
      files.push(new Promise((fileResolve, fileReject) => {
        stream.on('end', () => fileResolve({ bytes: Buffer.concat(chunks), fileName: info.filename ?? '' }));
        stream.on('error', fileReject);
      }));
    });
    parser.on('field', (name, value, info) => {
      if (!allowedFields.includes(name) || info.valueTruncated) malformed = true;
      else fields[name] = value;
    });
    parser.on('filesLimit', () => { malformed = true; });
    parser.on('fieldsLimit', () => { malformed = true; });
    parser.on('partsLimit', () => { malformed = true; });
    parser.on('error', () => reject(AppError.badRequest('multipart_invalid', 'The uploaded form is malformed.')));
    parser.on('close', async () => {
      try {
        const completedFiles = await Promise.all(files);
        if (tooLarge) throw new AppError(413, 'file_too_large', 'The uploaded file exceeds the allowed size.');
        if (malformed || completedFiles.length !== 1) throw AppError.badRequest('multipart_invalid', 'The uploaded form is malformed.');
        resolve({ file: completedFiles[0], fields });
      } catch (error) { reject(error); }
    });
    req.pipe(parser);
  });
}