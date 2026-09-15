import * as THREE from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';

// Built in the launch scene's coordinates: +X is the face of the media,
// +Y is up. Keeping the same contract lets the N64 sequence animate this rig.
function grainTexture() {
  const canvas=document.createElement('canvas');canvas.width=canvas.height=128;
  const ctx=canvas.getContext('2d'),data=ctx.createImageData(128,128);
  let seed=64;
  for(let i=0;i<data.data.length;i+=4){seed=(seed*1664525+1013904223)>>>0;const v=180+(seed>>>27);data.data.set([v,v,v,255],i);}
  ctx.putImageData(data,0,0);
  const texture=new THREE.CanvasTexture(canvas);texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.repeat.set(5,5);
  return texture;
}
function lettering(text,background='#17151d',color='#e9e7dd') {
  const canvas=document.createElement('canvas');canvas.width=512;canvas.height=256;
  const ctx=canvas.getContext('2d');ctx.fillStyle=background;ctx.fillRect(0,0,512,256);
  ctx.fillStyle=color;ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='italic 900 170px Arial';ctx.fillText(text,256,136);
  const map=new THREE.CanvasTexture(canvas);map.colorSpace=THREE.SRGBColorSpace;
  return new THREE.MeshStandardMaterial({map,roughness:.86});
}
function box(parent,size,position,material,radius=.025) {
  const mesh=new THREE.Mesh(new RoundedBoxGeometry(...size,3,radius),material);mesh.position.set(...position);parent.add(mesh);return mesh;
}
function cylinder(parent,radius,height,position,material,segments=48) {
  const mesh=new THREE.Mesh(new THREE.CylinderGeometry(radius,radius,height,segments),material);mesh.position.set(...position);parent.add(mesh);return mesh;
}
export function createDisc(labelTexture) {
  const root=new THREE.Group(),disc=new THREE.Group();root.add(disc);
  // Ring geometry keeps a real centre hole, including while the disc spins.
  const silver=new THREE.MeshStandardMaterial({color:0xbdbcc8,metalness:.8,roughness:.3,side:THREE.DoubleSide});
  const rim=new THREE.Mesh(new THREE.RingGeometry(.064,.5,96),silver);rim.rotation.y=Math.PI/2;disc.add(rim);
  const back=rim.clone();back.position.x=-.008;disc.add(back);
  const edge=new THREE.Mesh(new THREE.CylinderGeometry(.5,.5,.008,96,1,true),silver);edge.rotation.z=Math.PI/2;edge.position.x=-.004;disc.add(edge);
  const canvas=document.createElement('canvas');canvas.width=canvas.height=512;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#24212a';ctx.fillRect(0,0,512,512);
  // The same painted artwork as the cartridge, clipped to a mini-disc label.
  ctx.globalAlpha=.65;ctx.drawImage(labelTexture.image,0,0,512,512);ctx.globalAlpha=1;
  ctx.fillStyle='#22202c';ctx.fillRect(0,35,512,108);ctx.fillRect(0,376,512,85);
  ctx.textAlign='center';ctx.fillStyle='#eee9d8';ctx.font='italic 900 72px Arial';ctx.fillText('fun',256,113);
  ctx.font='900 32px Arial';ctx.fillText('MELEE',256,412);ctx.font='14px monospace';ctx.fillText('SMASH.FUN  •  OPTICAL GAME DISC',256,440);
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
  const face=new THREE.Mesh(new THREE.RingGeometry(.105,.476,96),new THREE.MeshStandardMaterial({map:texture,roughness:.82,side:THREE.DoubleSide}));face.rotation.y=Math.PI/2;face.position.x=.003;disc.add(face);
  root.scale.setScalar(.8);root.userData={homeY:.68,homeScale:.8,baseHomeScale:.8,baseDiameter:.8,isDisc:true};
  return root;
}
export function createGameCube() {
  const root=new THREE.Group(),grain=grainTexture();
  const purple=new THREE.MeshStandardMaterial({color:0x51477d,map:grain,roughness:.87});
  const dark=new THREE.MeshStandardMaterial({color:0x171620,roughness:.85});
  const silver=new THREE.MeshStandardMaterial({color:0xb5b3ad,roughness:.7,metalness:.18});
  // Size matches the old console/cartridge fit ratio: a mini-disc fits the tray.
  box(root,[.65,.48,.7],[0,-.24,0],purple,.04);
  box(root,[.666,.12,.66],[.006,-.34,0],silver,.022);
  cylinder(root,.252,.008,[0,.001,0],dark);
  cylinder(root,.023,.012,[0,.007,0],silver);
  // Four dark controller sockets and memory-card slots on the front (+X).
  for(const z of [-.245,-.082,.082,.245]){
    const socket=cylinder(root,.054,.026,[.343,-.30,z],dark,24);socket.rotation.z=Math.PI/2;
    box(root,[.008,.012,.075],[.358,-.315,z],silver,.002);
  }
  for(const z of [-.16,.16])box(root,[.015,.023,.12],[.337,-.41,z],dark,.004);
  for(let i=0;i<9;i++)box(root,[.23,.006,.008],[0,-.09-i*.02,.352],dark,.002);
  // Rear carry handle, visible as a real open arch.
  box(root,[.075,.065,.65],[-.43,-.19,0],dark,.025);
  for(const z of [-.29,.29])box(root,[.18,.065,.06],[-.355,-.19,z],dark,.02);
  for(const [x,z,r] of [[.23,-.26,.041],[.23,.26,.034],[-.24,.27,.028]])cylinder(root,r,.018,[x,.014,z],silver,24);
  const led=new THREE.MeshStandardMaterial({color:0xe69029,emissive:0xd46512,emissiveIntensity:.6});cylinder(root,.011,.021,[.27,.018,0],led,12);
  const lid=new THREE.Group();lid.position.set(-.235,.024,0);root.add(lid);
  cylinder(lid,.249,.025,[.235,0,0],purple);
  const badge=new THREE.Mesh(new THREE.CircleGeometry(.112,48),lettering('fun'));badge.rotation.set(-Math.PI/2,0,Math.PI/2);badge.position.set(.235,.014,0);lid.add(badge);
  lid.rotation.z=1.32;
  const badgeFront=new THREE.Mesh(new THREE.PlaneGeometry(.13,.058),lettering('fun'));badgeFront.rotation.y=Math.PI/2;badgeFront.position.set(.334,-.12,0);root.add(badgeFront);
  root.userData={snapAnchor:new THREE.Vector3(0,.008,0),mouthAnchor:new THREE.Vector3(0,.34,0),lid,isGameCube:true};
  return root;
}
