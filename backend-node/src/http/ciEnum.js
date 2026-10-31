import { z } from 'zod';
import { matchEnum } from './enums.js';

// Body enum fields are read trimmed and case-insensitive. The value is normalised to the canonical
// name before z.enum, so " high " is stored as High. An unknown value is still a 400 (Zod's body, not invalid_<field>).
export const ciEnum = (values) => z.preprocess((raw) => matchEnum(raw, values) ?? raw, z.enum(values));
