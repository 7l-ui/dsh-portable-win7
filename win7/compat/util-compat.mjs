import util from 'node:util';
import compat from './preload.cjs';

export * from 'node:util';
export const getSystemErrorMessage = compat.getSystemErrorMessage;
export default util;
