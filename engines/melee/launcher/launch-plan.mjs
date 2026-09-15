export function isOriginalCharacter(value) {
  return value === 'random:vanilla' || /^vanilla:(?:[0-9]|1[0-9]|2[0-5])$/.test(value);
}

// An explicit original-fighter override survives the website's custom roster
// picks. The default random:vanilla opponent remains overridable by roster picks.
export function originalCharacter(port) {
  if (port.originalCharacter !== undefined) {
    if (!isOriginalCharacter(port.originalCharacter)) throw Error('Choose a valid original Melee fighter.');
    return port.originalCharacter;
  }
  return /^vanilla:(?:[0-9]|1[0-9]|2[0-5])$/.test(port.character) ? port.character : undefined;
}

export function withOriginalFighters(settings) {
  if (!Array.isArray(settings.ports) || settings.ports.length !== 4) throw Error('Four player assignments are required.');
  return {...settings, ports:settings.ports.map((port,index) => ({...port,
    originalCharacter:originalCharacter(port) || (index === 0 ? 'vanilla:8' : 'random:vanilla'),
  }))};
}

export function launchFighter(schema, settings, action, roster) {
  const port = settings.ports.find(port => port.device !== 'off') || settings.ports[0];
  const character = port.character === 'selected' ? action.character?.slug : port.character;
  if (isOriginalCharacter(character)) {
    const original = schema.fighters.find(fighter => 'vanilla:' + fighter.id === character);
    const target = schema.targets.find(target => target.fighter === original?.id)?.slug || 'mario';
    return {slug:'original-melee',name:original?.label || 'Original Melee',short:'MELEE',target,original:true};
  }
  return roster.find(fighter => fighter.slug === character) || (character === 'random' ? roster[0] : undefined);
}

export function selectionPorts(plan,selectionMode,mode=0){
 const humans=plan.flatMap((slot,index)=>['keyboard','gamepad'].includes(slot?.kind)?[index]:[]);
 const cpus=plan.flatMap((slot,index)=>!slot||slot.kind==='cpu'?[index]:[]);
 return selectionMode==='full-roster'&&mode===0?[...humans,...cpus]:humans;
}
// Translate the launcher's device assignments and ordered roster picks; all
// costume allocation and engine validation remain in Melee's planLaunch.
export function applyLauncherSelection(settings, action) {
  if (!action.portPlan) return {...settings,ports:settings.ports.map(port => ({...port,character:originalCharacter(port) || port.character}))};
  if (action.portPlan.length !== 4) throw Error('Four player assignments are required.');
  const picks=[action.character,...(action.picks||[])].filter(Boolean);
  const mode=action.type==='start'?4:action.type==='select'?2:settings.mode;
  const selectedPorts=selectionPorts(action.portPlan,action.selectionMode,mode);
  return {...settings,mode,ports:settings.ports.map((port,index)=>{
    const slot=action.portPlan[index];
    const device=slot?.kind==='gamepad'?`gamepad${slot.index}`:slot?.kind==='keyboard'?'keyboard':slot?.kind==='none'?'off':'cpu';
    const chosen=picks[selectedPorts.indexOf(index)];
    return {...port,device,character:originalCharacter(port) || chosen?.slug || (device==='off'?'vanilla:2':port.character==='selected'?'random':port.character)};
  })};
}
