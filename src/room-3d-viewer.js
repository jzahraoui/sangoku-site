import * as THREE from 'three';

class Room3DViewer {
  static COLORS = {
    SUB: 0x8b4513,
    CEILING: 0x00aaff,
    CENTER: 0x333333,
    FRONT: 0x444444,
    SURROUND: 0x555555,
    BACK: 0x666666,
  };

  static ROOM_DIMENSIONS = {
    WIDTH: 4,
    HEIGHT: 2.5,
    DEPTH: 6,
  };

  constructor(canvasId, options = {}) {
    this.canvas = document.getElementById(canvasId);
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.animationId = null;
    this.rotationSpeed = options.rotationSpeed ?? 0.005;
    this.isVisible = true;
    this.observer = null;
  }

  init(detectedChannels) {
    if (!this.canvas || !detectedChannels?.length) return;

    this.destroy();

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 600 / 400, 0.1, 1000);
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
    this.setupVisibilityObserver();
    this.animate();
  }

  setupVisibilityObserver() {
    if (!('IntersectionObserver' in globalThis)) return;

    this.observer = new IntersectionObserver(
      entries => {
        this.isVisible = entries[0].isIntersecting;
      },
      { threshold: 0 }
    );
    this.observer.observe(this.canvas);
  }

  createRoom() {
    const { WIDTH, HEIGHT, DEPTH } = Room3DViewer.ROOM_DIMENSIONS;
    const roomGeo = new THREE.BoxGeometry(WIDTH, HEIGHT, DEPTH);
    const roomMat = new THREE.MeshBasicMaterial({
      color: 0x4a90e2,
      transparent: true,
      opacity: 0.05,
      side: THREE.BackSide,
    });
    this.scene.add(new THREE.Mesh(roomGeo, roomMat));

    const edges = new THREE.EdgesGeometry(roomGeo, 1);
    const roomLines = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0x4a90e2 })
    );
    this.scene.add(roomLines);
  }

  createScreen() {
    const screenGeo = new THREE.PlaneGeometry(2, 1.13);
    const screenMat = new THREE.MeshBasicMaterial({
      color: 0x1a1a1a,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
    });
    const screen = new THREE.Mesh(screenGeo, screenMat);
    screen.position.set(0, 0.3, -2.99);
    this.scene.add(screen);

    const screenEdges = new THREE.EdgesGeometry(screenGeo);
    const screenBorder = new THREE.LineSegments(
      screenEdges,
      new THREE.LineBasicMaterial({ color: 0x666666 })
    );
    screenBorder.position.set(0, 0.3, -2.99);
    this.scene.add(screenBorder);
  }

  createSpeakers(detectedChannels) {
    const listeningPos = 1;
    const subCount = detectedChannels.filter(ch => ch.commandId?.startsWith('SW')).length;

    const config = {
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
      SW3: {
        pos: subCount === 3 ? [0, -1.025, 2.75] : [-1.75, -1.025, 2.75],
        type: 'sub',
      },
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

    // Canapé à la position d'écoute
    this.createCouch(listeningPos);

    for (const ch of detectedChannels) {
      const cfg = config[ch.commandId];
      if (!cfg) continue;

      const { geo, color } = this.getSpeakerGeometry(cfg.type);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 });
      const speaker = new THREE.Mesh(geo, mat);
      speaker.position.set(...cfg.pos);
      this.scene.add(speaker);

      const edges = new THREE.EdgesGeometry(geo);
      const line = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: 0xffffff })
      );
      line.position.set(...cfg.pos);
      this.scene.add(line);
    }
  }

  createCouch(zPosition) {
    const couchColor = 0x654321;

    // Assise
    const seatGeo = new THREE.BoxGeometry(1.8, 0.3, 0.8);
    const seatMat = new THREE.MeshBasicMaterial({
      color: couchColor,
      transparent: true,
      opacity: 0.7,
    });
    const seat = new THREE.Mesh(seatGeo, seatMat);
    seat.position.set(0, -0.95, zPosition);
    this.scene.add(seat);

    // Dossier
    const backGeo = new THREE.BoxGeometry(1.8, 0.6, 0.15);
    const back = new THREE.Mesh(backGeo, seatMat);
    back.position.set(0, -0.55, zPosition + 0.35);
    this.scene.add(back);

    // Accoudoirs
    const armGeo = new THREE.BoxGeometry(0.15, 0.5, 0.8);
    const armLeft = new THREE.Mesh(armGeo, seatMat);
    armLeft.position.set(-0.9, -0.7, zPosition);
    this.scene.add(armLeft);

    const armRight = new THREE.Mesh(armGeo, seatMat);
    armRight.position.set(0.9, -0.7, zPosition);
    this.scene.add(armRight);
  }

  getSpeakerGeometry(type) {
    switch (type) {
      case 'sub':
        return {
          geo: new THREE.BoxGeometry(0.45, 0.45, 0.45),
          color: Room3DViewer.COLORS.SUB,
        };
      case 'ceiling':
        return {
          geo: new THREE.CylinderGeometry(0.15, 0.15, 0.2, 16),
          color: Room3DViewer.COLORS.CEILING,
        };
      case 'center':
        return {
          geo: new THREE.BoxGeometry(0.6, 0.3, 0.3),
          color: Room3DViewer.COLORS.CENTER,
        };
      case 'front':
        return {
          geo: new THREE.BoxGeometry(0.3, 1.3, 0.35),
          color: Room3DViewer.COLORS.FRONT,
        };
      case 'frontwide':
        return {
          geo: new THREE.BoxGeometry(0.25, 0.4, 0.25),
          color: Room3DViewer.COLORS.FRONT,
        };
      case 'surround':
        return {
          geo: new THREE.BoxGeometry(0.25, 0.35, 0.25),
          color: Room3DViewer.COLORS.SURROUND,
        };
      default:
        return {
          geo: new THREE.BoxGeometry(0.25, 0.3, 0.25),
          color: Room3DViewer.COLORS.BACK,
        };
    }
  }

  animate() {
    this.animationId = requestAnimationFrame(() => this.animate());
    if (this.isVisible) {
      this.scene.rotation.y += this.rotationSpeed;
      this.renderer.render(this.scene, this.camera);
    }
  }
  destroy() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

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
