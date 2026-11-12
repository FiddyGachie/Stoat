import { Express } from 'express';
import { EventEmitter } from 'node:events';

export interface TestResponse {
  status: number;
  body: any;
  headers: Record<string, string>;
}

export function dispatch(
  app: Express,
  options: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    url: string;
    headers?: Record<string, string>;
    body?: any;
  }
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(options.headers || {}),
    };

    // Normalize header keys to lowercase
    const normalizedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      normalizedHeaders[k.toLowerCase()] = v;
    }

    const req: any = new EventEmitter();
    req.method = options.method;
    req.url = options.url;
    req.headers = normalizedHeaders;
    req.body = options.body;
    req.socket = { remoteAddress: '127.0.0.1' };
    req.query = {};

    const queryString = options.url.split('?')[1];
    if (queryString) {
      req.query = Object.fromEntries(new URLSearchParams(queryString));
    }

    const resHeaders: Record<string, string> = {};
    let statusCode = 200;
    let resBody: any = null;

    const res: any = new EventEmitter();
    res.statusCode = 200;
    res.setHeader = (name: string, value: string) => {
      resHeaders[name.toLowerCase()] = value;
    };
    res.getHeader = (name: string) => resHeaders[name.toLowerCase()];
    res.status = (code: number) => {
      statusCode = code;
      res.statusCode = code;
      return res;
    };
    res.json = (data: any) => {
      resBody = data;
      resHeaders['content-type'] = 'application/json';
      resolve({ status: statusCode, body: resBody, headers: resHeaders });
      return res;
    };
    res.send = (data: any) => {
      if (typeof data === 'object') {
        return res.json(data);
      }
      resBody = data;
      resolve({ status: statusCode, body: resBody, headers: resHeaders });
      return res;
    };
    res.end = () => {
      resolve({ status: statusCode, body: resBody, headers: resHeaders });
    };

    try {
      app(req, res);
    } catch (err) {
      reject(err);
    }
  });
}
