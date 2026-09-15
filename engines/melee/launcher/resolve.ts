import {meleePath} from '../web/lib/paths';
import type {Fighter} from '../web/lib/fighter';
import type {Settings} from '../web/lib/launch';
import {resolveFighters as resolve} from './resolve-fighters.mjs';
export function resolveFighters(action:any,roster:Fighter[],signal:AbortSignal,onStatus:(message:string)=>void,settings:Settings){
 return resolve(action,roster,settings,{signal,onStatus,pathFor:meleePath});
}
