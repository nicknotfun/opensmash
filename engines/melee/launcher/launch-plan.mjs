// Translate the launcher's device assignments and ordered roster picks; all
// costume allocation and engine validation remain in Melee's planLaunch.
export function applyLauncherSelection(settings, action) {
  if (!action.portPlan) return settings;
  if (action.portPlan.length !== 4) throw Error('Four player assignments are required.');
  const picks=[action.character,...(action.picks||[])].filter(Boolean);
  let pick=0;
  return {...settings,ports:settings.ports.map((port,index)=>{
    const slot=action.portPlan[index];
    const device=slot?.kind==='gamepad'?`gamepad${slot.index}`:slot?.kind==='keyboard'?'keyboard':slot?.kind==='none'?'off':'cpu';
    const chosen=(device==='keyboard'||device.startsWith('gamepad'))?picks[pick++]:null;
    return {...port,device,character:chosen?.slug || (device==='off'?'vanilla:2':port.character==='selected'?'random':port.character)};
  })};
}
