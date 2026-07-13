import * as THREE from 'three';

const COLORS = {
  SUB: 0x8b4513,
  CEILING: 0x00aaff,
  CENTER: 0x333333,
  FRONT: 0x444444,
  SURROUND: 0x555555,
  BACK: 0x666666,
  ROOM: 0x4a90e2,
  SCREEN: 0x1a1a1a,
  SCREEN_BORDER: 0x666666,
  COUCH: 0x654321,
  OUTLINE: 0xffffff,
};

const ROOM_DIMENSIONS = {
  WIDTH: 4,
  HEIGHT: 2.5,
  DEPTH: 6,
};

// Placement des enceintes par identifiant de canal. La position de SW3 dépend
// du nombre de subs et est résolue dans createSpeakers().
const SPEAKER_CONFIG = {
  FL: { pos: [-1.2, -0.55, -2.85], type: 'front' },
  FR: { pos: [1.2, -0.55, -2.85], type: 'front' },
  C: { pos: [0, -0.75, -2.85], type: 'center' },
  FWL: { pos: [-1.5, 0.5, -2.85], type: 'frontwide' },
  FWR: { pos: [1.5, 0.5, -2.85], type: 'frontwide' },
  SLA: { pos: [-1.9, -0.15, 0.8], type: 'surround' },
  SRA: { pos: [1.9, -0.15, 0.8], type: 'surround' },
  SBL: { pos: [-1, -0.15, 2.85], type: 'back' },
  SBR: { pos: [1, -0.15, 2.85], type: 'back' },
  SBC: { pos: [0, -0.15, 2.85], type: 'back' },
  SW1: { pos: [-1.75, -1.025, -2.75], type: 'sub' },
  SW2: { pos: [1.75, -1.025, -2.75], type: 'sub' },
  SW3: { pos: [-1.75, -1.025, 2.75], type: 'sub' },
  SW4: { pos: [1.75, -1.025, 2.75], type: 'sub' },
  SWMIX: { pos: [-1.75, -1.025, -2.75], type: 'sub' },
  FHL: { pos: [-1.2, 1.2, -1.5], type: 'ceiling' },
  FHR: { pos: [1.2, 1.2, -1.5], type: 'ceiling' },
  CH: { pos: [0, 1.2, -1.5], type: 'ceiling' },
  TFL: { pos: [-1.2, 1.2, 0], type: 'ceiling' },
  TFR: { pos: [1.2, 1.2, 0], type: 'ceiling' },
  TML: { pos: [-1.2, 1.2, 1], type: 'ceiling' },
  TMR: { pos: [1.2, 1.2, 1], type: 'ceiling' },
  TRL: { pos: [-1, 1.2, 2], type: 'ceiling' },
  TRR: { pos: [1, 1.2, 2], type: 'ceiling' },
  SHL: { pos: [-1.5, 1.2, 0.8], type: 'ceiling' },
  SHR: { pos: [1.5, 1.2, 0.8], type: 'ceiling' },
  RHL: { pos: [-1, 1.2, 2], type: 'ceiling' },
  RHR: { pos: [1, 1.2, 2], type: 'ceiling' },
  FDL: { pos: [-1.2, 1.2, -1.5], type: 'ceiling' },
  FDR: { pos: [1.2, 1.2, -1.5], type: 'ceiling' },
  SDL: { pos: [-1.5, 1.2, 0.8], type: 'ceiling' },
  SDR: { pos: [1.5, 1.2, 0.8], type: 'ceiling' },
  BDL: { pos: [-1, 1.2, 2.2], type: 'ceiling' },
  BDR: { pos: [1, 1.2, 2.2], type: 'ceiling' },
  TS: { pos: [0, 1.2, 1], type: 'ceiling' },
};

const SW3_CENTER_POS = [0, -1.025, 2.75];

class Room3DViewer {
  static COLORS = COLORS;
  static ROOM_DIMENSIONS = ROOM_DIMENSIONS;

  constructor(canvasId, options = {}) {
    this.canvas = document.getElementById(canvasId);
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.animationId = null;
    this.rotationSpeed = options.rotationSpeed ?? 0.005;
    this.observer = null;
    this.resizeObserver = null;
  }

  init(detectedChannels) {
    if (!this.canvas || !detectedChannels?.length) return;

    this.destroy();

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1.5, 0.1, 1000);
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
    });

    this.camera.position.set(5, 4, 5);
    this.camera.lookAt(0, 0, 0);

    this.createRoom();
    this.createScreen();
    this.createSpeakers(detectedChannels);
    this.setupResize();
    this.setupVisibilityObserver();

    // Sans IntersectionObserver, la boucle démarre inconditionnellement.
    if (!this.observer) this.startLoop();
  }

  // Ajuste le tampon de rendu à la taille CSS courante du canvas, avec prise en
  // compte de la densité de pixels (rendu net sur écrans HiDPI/Retina).
  resize() {
    const width = this.canvas.clientWidth || 600;
    const height = this.canvas.clientHeight || 400;
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  setupResize() {
    this.resize();
    if ('ResizeObserver' in globalThis) {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.canvas);
    }
  }

  setupVisibilityObserver() {
    if (!('IntersectionObserver' in globalThis)) return;

    this.observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting) this.startLoop();
        else this.stopLoop();
      },
      { threshold: 0 }
    );
    this.observer.observe(this.canvas);
  }

  // Ajoute un maillage à la scène, avec en option un contour en arêtes vives.
  addMesh(geometry, color, { position, opacity = 0.8, side = THREE.FrontSide, outline, outlineColor = COLORS.OUTLINE } = {}) {
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side });
    const mesh = new THREE.Mesh(geometry, material);
    if (position) mesh.position.set(...position);
    this.scene.add(mesh);

    if (outline) {
      const edges = new THREE.EdgesGeometry(geometry, 1);
      const lines = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: outlineColor }));
      if (position) lines.position.set(...position);
      this.scene.add(lines);
    }
    return mesh;
  }

  createRoom() {
    const { WIDTH, HEIGHT, DEPTH } = ROOM_DIMENSIONS;
    this.addMesh(new THREE.BoxGeometry(WIDTH, HEIGHT, DEPTH), COLORS.ROOM, {
      opacity: 0.05,
      side: THREE.BackSide,
      outline: true,
      outlineColor: COLORS.ROOM,
    });
  }

  createScreen() {
    this.addMesh(new THREE.PlaneGeometry(2, 1.13), COLORS.SCREEN, {
      position: [0, 0.3, -2.99],
      side: THREE.DoubleSide,
      outline: true,
      outlineColor: COLORS.SCREEN_BORDER,
    });
  }

  createSpeakers(detectedChannels) {
    const listeningPos = 1;
    const subCount = detectedChannels.filter(ch => ch.commandId?.startsWith('SW')).length;

    // Canapé à la position d'écoute
    this.createCouch(listeningPos);

    for (const ch of detectedChannels) {
      const cfg = SPEAKER_CONFIG[ch.commandId];
      if (!cfg) continue;

      const position = ch.commandId === 'SW3' && subCount === 3 ? SW3_CENTER_POS : cfg.pos;
      const { geo, color } = this.getSpeakerGeometry(cfg.type);
      this.addMesh(geo, color, { position, outline: true });
    }
  }

  createCouch(zPosition) {
    const opts = { opacity: 0.7 };
    // Assise
    this.addMesh(new THREE.BoxGeometry(1.8, 0.3, 0.8), COLORS.COUCH, { ...opts, position: [0, -0.95, zPosition] });
    // Dossier
    this.addMesh(new THREE.BoxGeometry(1.8, 0.6, 0.15), COLORS.COUCH, {
      ...opts,
      position: [0, -0.55, zPosition + 0.35],
    });
    // Accoudoirs
    this.addMesh(new THREE.BoxGeometry(0.15, 0.5, 0.8), COLORS.COUCH, { ...opts, position: [-0.9, -0.7, zPosition] });
    this.addMesh(new THREE.BoxGeometry(0.15, 0.5, 0.8), COLORS.COUCH, { ...opts, position: [0.9, -0.7, zPosition] });
  }

  getSpeakerGeometry(type) {
    switch (type) {
      case 'sub':
        return { geo: new THREE.BoxGeometry(0.45, 0.45, 0.45), color: COLORS.SUB };
      case 'ceiling':
        return { geo: new THREE.CylinderGeometry(0.15, 0.15, 0.2, 16), color: COLORS.CEILING };
      case 'center':
        return { geo: new THREE.BoxGeometry(0.6, 0.3, 0.3), color: COLORS.CENTER };
      case 'front':
        return { geo: new THREE.BoxGeometry(0.3, 1.3, 0.35), color: COLORS.FRONT };
      case 'frontwide':
        return { geo: new THREE.BoxGeometry(0.25, 0.4, 0.25), color: COLORS.FRONT };
      case 'surround':
        return { geo: new THREE.BoxGeometry(0.25, 0.35, 0.25), color: COLORS.SURROUND };
      default:
        return { geo: new THREE.BoxGeometry(0.25, 0.3, 0.25), color: COLORS.BACK };
    }
  }

  startLoop() {
    if (this.animationId === null) this.animate();
  }

  stopLoop() {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  animate() {
    this.animationId = requestAnimationFrame(() => this.animate());
    this.scene.rotation.y += this.rotationSpeed;
    this.renderer.render(this.scene, this.camera);
  }

  destroy() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    this.stopLoop();

    if (this.scene) {
      this.scene.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) {
            for (const mat of obj.material) {
              mat.dispose();
            }
          } else {
            obj.material.dispose();
          }
        }
      });
      this.scene.clear();
    }

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }

    this.scene = null;
    this.camera = null;
  }
}

export { Room3DViewer };
