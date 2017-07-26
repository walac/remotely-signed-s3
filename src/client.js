import assert from 'assert';
import crypto from 'crypto';
import zlib from 'zlib';
import stream from 'stream';

import fs from 'mz/fs';

import Runner from './runner';
import InterchangeFormat from './interchange-format';
import DigestStream from './digest-stream';
import {Joi, schemas, runSchema, MB, GB, TB} from './schemas';

const MAX_S3_CHUNKS = 10000;

/**
 * This class represents a client of a service implemented using the
 * `Controller` class.
 */
class Client {

  constructor(opts) {
    opts = runSchema(opts || {}, Joi.object().keys({
      runner: Joi.any(),
      runnerOpts: Joi.object().default({}),
      partsize: Joi.number().min(5*MB).max(5*GB).default(25*MB),
      multisize: Joi.number().default(100*MB),
    }).without('runner', 'runnerOpts')
      .optionalKeys(['runner', 'runnerOpts']));

    let {runner, runnerOpts, partsize, multisize} = opts;

    // Store value and not reference
    this.partsize = partsize+0;

    // Unlike the Controller, which has much simplier usage, here we do want
    // the full Runner api to be available to the client
    if (!runner) {
      runner = new Runner(opts.runnerOpts);
    }
    
    // The Runner to use for this
    this.runner = runner;

    // The minimum size before switching to multipart
    this.multisize = opts.multisize;
  }


  async __prepareSinglepartUpload(opts) {
    let {filename} = opts;
    let filestats = await fs.stat(filename);
    let sha256 = crypto.createHash('sha256');
    let size = 0;
    let stream = fs.createReadStream(filename, {start: 0});
    return new Promise((resolve, reject) => {
      stream.on('error', reject);

      stream.on('data', data => {
        sha256.update(data);
        size += data.length;
      });

      stream.on('end', async () => {
        let finishedstats = await fs.stat(filename);
        if (size !== filestats.size) {
          throw new Error('File has a different number of bytes than was hashed');
        } else if (finishedstats.size !== filestats.size) {
          reject(new Error('File changed size during preperation'));
        } else if (finishedstats.mtime.getTime() !== filestats.mtime.getTime()){
          reject(new Error('File was modified during preperation'));
        } else if (finishedstats.ino !== filestats.ino){
          reject(new Error('File has changed inodes'));
        } else {
          sha256 = sha256.digest('hex');
          resolve({
            filename,
            sha256,
            size,
          });
        }
      });
    });
  }

  async __prepareMultipartUpload(opts) {
    opts = opts || {};
    let {filename, partsize} = opts;
    // Ensure we're copying the value and not changing it
    partsize = (partsize || this.partsize);

    let sha256 = crypto.createHash('sha256');
    let filestats = await fs.stat(filename);
    let size = 0; // the computed size, to check against result of stat();
    let partcount = Math.ceil(filestats.size / partsize);
    let parts = [];

    if (partsize/size < 2) {
      throw new Error('Multipart upload must have at least 2 parts');
    }

    for (let part = 0 ; part < partcount ; part++) {
      await new Promise((resolve, reject) => {
        let parthash = crypto.createHash('sha256');
        let start = part * partsize;
        let end = start + partsize - 1;
        let currentPartsize = 0;

        let partstream = fs.createReadStream(filename, {start, end});

        partstream.on('error', reject);

        partstream.on('data', data => {
          size += data.length;
          currentPartsize += data.length;
          sha256.update(data);
          parthash.update(data);
        });

        partstream.on('end', () => {
          // All parts other than the last one should have a size no greater than
          // the partsize requested
          if (part < partcount - 1) {
            if (partsize !== currentPartsize) {
              throw new Error('All parts before last part must be exactly requested size');
            }
          } else if (part === partcount - 1) {
            if (currentPartsize > partsize) {
              throw new Error('Final part exceeds allowed size');
            }
          }
          parts.push({sha256: parthash.digest('hex'), size: currentPartsize, start});
          resolve();
        });
      });
    }

    sha256 = sha256.digest('hex');

    // Now make sure that in the meantime that the file didn't change out from
    // under us.  It's still possible for a properly motivated person
    // to reset the mtime and size to what we expect, but these checks
    // are more about non-intentional mistakes.  We cannot compare hashes before
    // and after since we're computing the hash 
    let finishedstats = await fs.stat(filename);
    if (size !== filestats.size) {
      throw new Error('File has a different number of bytes than was hashed');
    } else if (finishedstats.size !== filestats.size) {
      reject(new Error('File changed size during preperation'));
    } else if (finishedstats.mtime.getTime() !== filestats.mtime.getTime()){
      reject(new Error('File was modified during preperation'));
    } else if (finishedstats.ino !== filestats.ino){
      reject(new Error('File has changed inodes'));
    } else {
      return {filename, sha256, size, parts};
    }
  }

  __useMulti(size, forceMP, forceSP) {
    // We want the ability to force multi or single
    forceMP = process.env.FORCE_MP || forceMP;
    forceSP = process.env.FORCE_SP || forceSP;

    if (!size) {
      throw new Error('You must provide a size');
    }

    if (forceMP && forceSP) {
      throw new Error('Forcing singlepart and multipart is mutually exclusive');
    } else if (forceMP) {
      return true;
    } else if (forceSP) {
      return false;
    } else if (size >= this.multisize) {
      return true;
    } else {
      return false;
    }
  }

  async prepareUpload(opts) {
    opts = runSchema(opts, Joi.object().keys({
      filename: Joi.string().required(),
      forceMP: Joi.boolean().truthy(),
      forceSP: Joi.boolean().truthy(),
      partsize: Joi.number().max(5 * GB).default(this.partsize),
    }).without('forceSP', 'forceMP'));
    let {filename, partsize, forceMP, forceSP} = opts;

    let filesize = (await fs.stat(filename)).size;
    if (typeof filesize !== 'number') {
      throw new Error('Unable to determine filesize of ' + filename);
    }

    if (this.__useMulti(filesize, forceMP, forceSP)) {
      return this.__prepareMultipartUpload({filename, partsize});
    } else {
      return this.__prepareSinglepartUpload({filename});
    }
  }

  /**
   * Compress a file and return the pre-compression SHA256 and size.
   * This is a helper function for implementing compression using the
   * Content-Encoding related parameters (transferSha256 and transferSize)
   * in the `src/controller.js` class
   *
   * NOTE: This must be used before prepareUpload, and for multipart uploads
   * you need to pass the outputFilename specified here instead of the input
   * one
   */
  async compressFile(opts) {
    opts = runSchema(opts, Joi.object().keys({
      inputFilename: Joi.string().required(),
      compressor: Joi.string().valid(['identity', 'gzip']).default('identity'),
      outputFilename: Joi.string().required(),
    }));

    let {inputFilename, compressor, outputFilename} = opts;

    let inputStream = fs.createReadStream(inputFilename);
    let outputStream = fs.createWriteStream(outputFilename);
    let preCompressionDigest = new DigestStream();
    let postCompressionDigest = new DigestStream();
    let compressionStream;
    switch (compressor) {
      case 'gzip':
        compressionStream = zlib.createGzip();
        break;
      case 'identity':
        compressionStream = new stream.PassThrough();
        break;
    }
    return new Promise((resolve, reject) => {
      inputStream.on('error', reject);
      outputStream.on('error', reject);
      preCompressionDigest.on('error', reject);
      postCompressionDigest.on('error', reject);
      compressionStream.on('error', reject);

      outputStream.on('finish', () => {
        let info = {
          sha256: preCompressionDigest.hash,
          size: preCompressionDigest.size,
          transferSha256: postCompressionDigest.hash,
          transferSize: postCompressionDigest.size,
        };
        switch (compressor) {
          case 'identity':
            info.contentEncoding = 'identity';
            break;
          case 'gzip':
            info.contentEncoding = 'gzip';
            break;
        }
        resolve(info);
      });

      inputStream
        .pipe(preCompressionDigest)
        .pipe(compressionStream)
        .pipe(postCompressionDigest)
        .pipe(outputStream);

    });
  }

  /**
   * Take a request and upload metadata and return a string wihch represents
   * an invocation of the curl command line which approximates the equivalent
   * http requests which this class would make
   */
  __curl(request, upload) {
    let {headers, method, url} = request;
    let {filename} = upload;
    let command = ['curl'];
    method = method || 'GET';
    command.push(`-X ${method}`);
    for (let header in headers) {
      command.push(`-H "${header}: ${headers[header]}"`);
    }
    command.push(url);
    command.push(`--data-binary @${upload.filename}`)
    return command.join(' ');
  }

  /**
   * Take the list of requests in interchange format and 
   * run them using the information from the upload preperation
   * list
   */
  async runUpload(request, upload) {
    upload = runSchema(upload, Joi.object().keys({
      filename: Joi.string().required(),
      sha256: schemas.sha256.required(),
      size: Joi.number().required(),
      parts: schemas.parts.required(),
    }).optionalKeys('parts'));

    let {filename, sha256, size, parts} = upload;
    let etags = [];
    let responses = [];

    if (!Array.isArray(request)) {
      request = [request];
    }

    for (let req of request) {
      await InterchangeFormat.validate(req);
    }

    if (!parts) {
      parts = [{sha256, size, start: 0}];
    }

    if (request.length !== parts.length) {
      throw new Error('Number of requests does not match number of parts');
    }

    for (let n = 0; n < request.length ; n++) {
      let {sha256, start, size} = parts[n];
      let req = request[n];
      function body() {
        let end = start + size - 1;
        return fs.createReadStream(filename, {start, end});
      };

      let result = await this.runner.run({req, body});

      if (result.statusCode >= 300) {
        let err = new Error(`Failed to run a request ${req.method} ${req.url}`);
        err.url = req.url;
        err.method = req.method;
        err.headers = req.headers;
        err.body = result.body.toString();
        throw err;
      }

      let etag;

      if (result && result.headers && result.headers.etag) {
        // This header is occasionally returned wrapped in quotation marks.
        etag = result.headers.etag.trim();
        /*if (etag.charAt(0) === '"') {
          etag = etag.slice(1);
          if (etag.charAt(etag.length - 1) === '"') {
            etag = etag.slice(0, etag.length - 1);
          } else {
            throw new Error('Mismatched quotation marks around ETag');
          }
        }*/
      }

      // I'm not entirely happy with this.  It's almost completely 
      // here for unit tests.  It's not dangerous because a lack of
      // an ETag will just cause the upload to fail for a multipart
      // upload because it cannot commit the upload and it is not
      // important for a single part upload
      etags.push(etag || 'NOETAG');
      responses.push(result);
    }
    return {etags, responses};
  }

}

module.exports = Client;
