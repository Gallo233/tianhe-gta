import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { CAMERA, CHARACTERS, PHYSICS, fromBlender } from '../config';
import { Input } from '../core/Input';
import { Loop } from '../core/Loop';
import { createRenderer, resizeRenderer } from '../core/Renderer';
import { Character } from '../entities/Character';
import { raycastVehicle, vehicleTemplate } from '../entities/VehicleModel';
import { CameraRig } from '../systems/CameraRig';
import { Controller, type MoveIntent } from '../systems/Controller';
import { DriveCar, Driving, WATER_Y, type DriveInput } from '../systems/Driving';
import { Hud } from '../systems/Hud';
import { Jobs, type JobEvent } from '../systems/Jobs';
import { Minimap } from '../systems/Minimap';
import { Pedestrians, type WalkGraph } from '../systems/Pedestrians';
import { Traffic, type Obstacle } from '../systems/Traffic';
import { BrainOverlay } from '../systems/BrainOverlay';
import { Sfx } from '../systems/Sfx';
import { Police } from '../systems/Police';
import { NpcBrain } from '../ai/NpcBrain';
import type { Crime, PlayerFacts } from '../ai/facts';
import type { CrimeKind } from '../ai/brainProtocol';
import { createSeededRandom } from '../utils/random';
import { cullChunks, loadCity, type CityData } from '../world/City';
import { Collision } from '../world/Collision';
import { Environment } from '../world/Environment';
import { RenderPipeline } from '../render/RenderPipeline';
import { FACADES, GZ } from '../world/Materials';
import { SignalLamps } from '../world/SignalLamps';
import { NightLights } from '../world/NightLights';
import { NearFuture } from '../world/NearFuture';
import { Weather } from '../world/Weather';
import { FacadeDetail } from '../world/FacadeDetail';
import { RoadIndex } from '../world/RoadIndex';
import { StreetFurniture, ZEBRA_HALF } from '../world/StreetFurniture';
import { Voice } from '../systems/Voice';
import { Radio } from '../systems/Radio';
import { RadioUI } from '../systems/RadioUI';
import { loadKits } from '../world/TexKits';
import { RoofClutter, backdropRoofs } from '../world/RoofClutter';
import { buildShopLight } from '../world/ShopLight';
import { HuachengSigns } from '../world/HuachengSigns';
import { MetroExits, metroKitNight, type MetroData, type MetroExit } from '../world/MetroExits';
import { MetroMenu } from '../systems/MetroMenu';
import { Apm, type ApmData } from '../world/Apm';
import { ApmTrains, closesAt, type Train } from '../world/ApmTrains';
import { ApmSigns } from '../world/ApmSigns';
import { ApmPassengers } from '../world/ApmPassengers';
import { dressApm } from '../world/ApmSurfaces';
import { ApmTunnelLights } from '../world/ApmTunnelLights';
import { EBike, type EBikeSpec } from '../entities/EBike';
import { RiderPose } from '../entities/RiderPose';
import { Bike, Riding, type CarBody2D } from '../systems/Riding';
import { DeliveryWorld, type ShopKind } from '../delivery/DeliveryWorld';
import { Actors } from '../delivery/Actors';
import { Dialogue } from '../delivery/Dialogue';
import { PhotoMode } from '../delivery/PhotoMode';
import { Orders } from '../delivery/Orders';
import { SPEAKERS } from '../delivery/Story';
import { HeadlightPools, PlayerHeadlights } from '../world/CarLights';
import { LampLights } from '../world/LampLights';
import { DroneShow } from '../world/DroneShow';
import { PropColliders } from '../world/PropColliders';
import { CarCollisions, obbContact } from '../systems/CarCollisions';
import { listQA, runQA } from '../qa/QA';
import { PlazaLife, type HuachengLayout } from '../world/PlazaLife';
import { MallSigns, type MallJson } from '../world/MallSigns';
import { FountainShow } from '../world/FountainShow';

// Guangzhou kit (guangzhou/scripts/gz_vehicles.py); share of traffic, buses kept to the arterials
const VEHICLES = ['taxi', 'sedan', 'suv', 'mpv', 'sports', 'bus'];
const MIX = [0.3, 0.24, 0.18, 0.1, 0.04, 0.08];
const ARTERIAL = [false, false, false, false, false, true];
const TRAFFIC_CARS = 220;
const WALKERS = 90;
/** Game minutes per real second (1 = a full day in 24 real minutes). */
const CLOCK_RATE = 1;

const _tSeg = new THREE.Line3(), _tCorr = new THREE.Vector3(), _tProbe = new THREE.Vector3();

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, 0.1, 30000);
  private readonly input: Input;
  readonly loop = new Loop((d, e) => this.update(d, e), () => this.render());
  readonly env: Environment;
  readonly pipeline: RenderPipeline;
  private readonly hud = new Hud(CHARACTERS);
  private readonly minimap = new Minimap(document.querySelector<HTMLCanvasElement>('#minimap')!);
  city!: CityData;
  collision!: Collision;
  private controller!: Controller;
  private rig!: CameraRig;
  jobs!: Jobs;
  characters: Character[] = [];
  pedestrians!: Pedestrians;
  traffic!: Traffic;
  private driving!: Driving;
  private readonly parked: DriveCar[] = [];
  private readonly seat = new Map<number, DriveCar>();
  private nearCar = false;
  active = 0;
  private ready = false;
  playing = false;
  private frame = 0;
  private elapsed = 0;
  private rng = createSeededRandom(7);
  private paused = false;
  private readonly moveVec = new THREE.Vector2();
  private readonly lookVec = new THREE.Vector2();
  private readonly intent: MoveIntent = { move: new THREE.Vector2(), sprint: false, walk: false, jump: false };
  readonly timings: Record<string, number> = {};
  private fpsAccum = 0;
  private fpsFrames = 0;
  private fps = 0;
  private simTime = 0;
  private readonly brain = new NpcBrain('api/npc-brain', createSeededRandom(11));
  private overlay!: BrainOverlay;
  private signals!: SignalLamps;
  private nightLights!: NightLights;
  nearFuture!: NearFuture;
  readonly weather = new Weather();
  facades!: FacadeDetail;
  roofs!: RoofClutter;
  furniture!: StreetFurniture;
  metro!: MetroExits;
  apm!: Apm;
  apmTrains!: ApmTrains;
  apmPax!: ApmPassengers;
  /** people who stay on 花城广场: groups, photographers, bench sitters, the evening square dance (null before a rebuild) */
  plaza: PlazaLife | null = null;
  /** 花城汇 B1 (gz_mall): its hanging signs, posters, directory and LED screen; its plan (null before a rebuild) */
  mallSigns: MallSigns | null = null;
  /** 花城广场's music fountain (gz_north): the shows */
  fountain: FountainShow | null = null;
  mall: MallJson | null = null;
  private tunnelLights!: ApmTunnelLights;
  /** Ah Jie's delivery e-scooter: the model, its physics state and the physics */
  ebike!: EBike;
  bike!: Bike;
  bikes!: Riding;
  /** a character on the e-bike: mount 0 (standing beside) .. 1 (seated); dir +1 getting on, -1 getting off */
  rider: { ch: number; pose: RiderPose; mount: number; dir: number; foot: number } | null = null;
  /** thrown off the bike: flying, sliding, lying, getting up */
  thrown: {
    ch: number; pos: THREE.Vector3; vel: THREE.Vector3; t: number; phase: 'air' | 'slide' | 'lying' | 'up';
    spin: number; tilt: number; yaw: number; hipH: number; feet: THREE.Vector3; roof: boolean;
    /** the tilt it comes to rest at: +pi/2 face down, -pi/2 on its back */
    lie: number;
  } | null = null;
  private readonly riderPoses = new Map<number, RiderPose>();
  /** the delivery game: shops / lobbies / doors, the people, conversations, the photo, the orders */
  delivery!: DeliveryWorld;
  actors!: Actors;
  dialogue!: Dialogue;
  photo!: PhotoMode;
  orders!: Orders;
  private hornHeld = false;
  /** the player on an APM train: which car, where in it (car-local Blender metres) */
  private riding: { train: Train; car: number; local: THREE.Vector3 } | null = null;
  private boardCool = 0;
  /** the APM station whose paid side the player is on (tapped in), or null */
  private apmPaid: string | null = null;
  private defaultOccluder: ((o: THREE.Vector3, d: THREE.Vector3, max: number) => number) | null = null;
  private metroMenu: MetroMenu | null = null;
  /** a metro ride in progress: fade out, move, fade in */
  private ride: { t: number; to: MetroExit; fare: number; minutes: number; moved: boolean } | null = null;
  private fade: HTMLDivElement | null = null;
  /** 羊城通 (the transit card) balance: rides come off it; it tops itself up from cash, ¥50 at a time */
  metroCard = 50;
  private readonly pools = new HeadlightPools();
  /** street lamps + the player's headlights: fixed light slots in every lit material */
  private readonly lampLights = new LampLights();
  private readonly headlights = new PlayerHeadlights(this.lampLights);
  private drones!: DroneShow;
  private readonly sfx = new Sfx();
  /** recorded voices for every line (Cantonese for the locals); see systems/Voice.ts */
  readonly voice = new Voice();
  /** music on the e-bike and in cars (the player's own songs, scripts/gz_music.py) */
  readonly radio = new Radio();
  radioUI!: RadioUI;
  private radioHint = false;
  /** gz_huacheng's plan: the sunken court of 花城汇 and its shop walls (null before a rebuild wrote it) */
  huacheng: { court: { bay: number; walls: { a: number[]; b: number[]; u0: number }[] } } | null = null;
  huachengSigns: HuachengSigns | null = null;
  /** last frame: riding or driving (what the music follows) */
  radioVehicle = false;
  private justChose = false;
  private readonly facts: PlayerFacts = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), driving: false, onSidewalk: false, sprinting: false, crash: null };
  private readonly prevPlayer = new THREE.Vector3();
  private readonly rawVel = new THREE.Vector3();
  private readonly groundProbe = new THREE.Vector3();
  readonly crimes: Crime[] = [];
  private crimeSeq = 0;
  private lastCarCrimeAt = -1e9;
  private police!: Police;
  private cullT = 0;
  private perfOn = false;
  private perfT = 0;
  private readonly safe = new THREE.Vector3();
  private wetT = 0;
  private walk!: WalkGraph;
  props!: PropColliders;
  readonly carHits = new CarCollisions();
  /** QA autopilot: replaces keyboard input for the player's car while set. */
  pilot: ((car: DriveCar, dt: number) => DriveInput) | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = createRenderer(canvas);
    const dummy = () => document.createElement('div');       // desktop only: no touch controls on the page
    this.input = new Input(canvas, dummy(), dummy(), dummy(), dummy(), dummy());
    this.env = new Environment(this.scene, this.renderer);
    this.pipeline = new RenderPipeline(this.renderer);
    this.env.attachGrade(this.pipeline.grade);
    this.env.setHour(16);
    resizeRenderer(this.renderer, this.camera);
    this.installHooks();
  }

  async start(): Promise<void> {
    const t0 = performance.now();
    const draco = new DRACOLoader().setDecoderPath('draco/');
    const loader = new GLTFLoader().setDRACOLoader(draco);
    const fill = el('#load-fill');
    const text = el('#load-text');
    let cityP = 0, charP = 0;
    const show = () => { fill.style.width = `${Math.round((cityP * 0.7 + charP * 0.3) * 100)}%`; };
    const charLoads = CHARACTERS.map((s) => loader.loadAsync(s.file, (e) => { if (e.total) charP = Math.max(charP, e.loaded / e.total); show(); }));
    const carLoads = VEHICLES.map((v) => loader.loadAsync(`assets/vehicles/gz_${v}.glb`));
    const carLodLoads = VEHICLES.map((v) => loader.loadAsync(`assets/vehicles/gz_${v}_lod2.glb`));
    const policeLoad = loader.loadAsync('assets/vehicles/gz_police.glb');
    const ebikeLoad = loader.loadAsync('assets/vehicles/gz_ebike.glb');
    const ebikeJson = fetch('assets/vehicles/gz_ebike.json').then((r) => r.json()) as Promise<EBikeSpec>;
    const shopKitLoad = loader.loadAsync('assets/street/gz_shopkit.glb');
    const shopKitJson = fetch('assets/street/gz_shopkit.json').then((r) => r.json());
    const deliveryJson = fetch('assets/tianhe/delivery.json').then((r) => r.json());
    const collisionLoad = loader.loadAsync('assets/tianhe/collision.glb');
    const kitLoad = loader.loadAsync('assets/street/street_kit.glb');
    const apmLoad = loader.loadAsync('assets/apm/apm.glb');
    const apmJson = fetch('assets/apm/apm.json').then((r) => r.json()) as Promise<ApmData>;
    const [walk, places, bjson, metroJson] = await Promise.all(['walkways.json', 'places.json', 'buildings.json', 'metro.json'].map((f) => fetch('assets/tianhe/' + f).then((r) => r.json())));
    const apmGltf = await apmLoad;
    this.apm = new Apm(apmGltf, await apmJson);
    dressApm(this.apm.group, this.apm.stations, this.apm.L);
    this.pipeline.setApmLevels(this.apm.L.concourse, this.apm.L.platform);
    this.scene.add(this.apm.group);
    this.apmTrains = new ApmTrains(apmGltf, this.apm);
    this.scene.add(this.apmTrains.group);
    this.apmTrains.onDepart = (t) => {
      if (this.riding?.train !== t || !t.next) return;
      this.hud.toast(`下一站：${t.next.name}　Next: ${t.next.en}`, '', 3);
      const end = (t.track === 1 && t.next.terminus === 'north') || (t.track === 0 && t.next.terminus === 'south');
      this.sfx.announce(`下一站，${end ? '终点站' : ''}${t.next.name}。`);
    };
    this.apmTrains.onStop = (t) => {
      if (this.riding?.train !== t || !t.at) return;
      this.hud.toast(t.terminus ? `${t.at.name}到了 · 终点站，请全部乘客下车` : `${t.at.name}到了 · 按 F 下车`, 'good', 3);
      // island platforms: the doors on the left in the direction of travel open, both ways
      this.sfx.announce(t.terminus ? `${t.at.name}站到了，这是本次列车的终点站，请全体乘客下车。` : `${t.at.name}站到了，请从左边车门下车。`);
    };
    this.metro = new MetroExits(metroJson as MetroData, this.apm.exitIds);
    this.apm.exitInfo = (id) => this.metro.exits.find((e) => e.id === id);
    this.scene.add(new ApmSigns(this.apm).mesh);
    this.walk = walk;
    const voices = this.voice.load();
    const music = this.radio.load();
    this.timings.texKits = await loadKits();          // before any city material is made: they bake the kits into their shaders
    this.city = await loadCity((f) => { cityP = f; show(); text.textContent = `加载城区 ${Math.round(f * 100)}%`; });
    await voices;
    this.timings.voices = this.voice.count;
    this.timings.songs = await music;
    this.radioUI = new RadioUI(this.radio, el('#hud'), {
      onOpen: () => { if (this.input.pointerLocked) document.exitPointerLock(); },
      onClose: (lock) => { if (lock && this.playing) this.input.requestLock(); },
      canOpen: () => this.playing,
    });
    // M / Esc open and close the player inside the key event itself: the pointer lock is only granted in a gesture
    window.addEventListener('keydown', (e) => {
      if (e.repeat || !this.playing || !this.radioUI) return;
      if (e.code === 'KeyM') this.radioUI.toggle();
      else if (e.code === 'Escape' && this.radioUI.open) this.radioUI.close(true);
    }, true);
    try { this.radioHint = localStorage.getItem('gz.radio.hint') === '1'; } catch { /* private window */ }
    this.scene.add(this.city.root);
    this.nightLights = new NightLights(this.city.lamps, this.lampLights);
    this.tunnelLights = new ApmTunnelLights(this.apm, this.lampLights);
    this.scene.add(this.nightLights.group);
    this.nearFuture = new NearFuture(this.city.footprints, this.city.roads);
    this.scene.add(this.nearFuture.group);
    this.scene.add(this.weather.group);
    this.facades = new FacadeDetail(bjson, new RoadIndex(this.city.roads));
    this.scene.add(this.facades.group);
    this.timings.cityLoadMs = Math.round(performance.now() - t0);
    text.textContent = '构建碰撞…';
    await nextFrame();
    const tc = performance.now();
    const kit = await kitLoad;
    metroKitNight(kit);
    // the metro pavilions' platforms, stairs and halls join the static collision (the wells are cut in Blender)
    this.collision = new Collision([(await collisionLoad).scene, boundaryWalls(this.city.meta.bounds_m), this.metro.collision(kit), this.apm.collisionGroup]);
    this.timings.bvhMs = Math.round(performance.now() - tc);
    const roadIndex = new RoadIndex(this.city.roads);
    const ground = (x: number, y: number) => this.collision.groundHeight(fromBlender(x, y, 8), 20);
    // what stands on the roofs: placed against the collision (only where the roof really is)
    const tr = performance.now(), probe = new THREE.Vector3();
    const FAM_MAT: Record<string, string> = { glass: 'GZ Facade | curtain wall', office: 'GZ Facade | office stone', resi: 'GZ Facade | residential tile',
      village: 'GZ Facade | urban village', podium: 'GZ Facade | podium', civic: 'GZ Facade | civic render', industrial: 'GZ Facade | industrial panel' };
    this.roofs = new RoofClutter(bjson, (x, z, top) => this.collision.groundHeight(probe.set(x, top, z), 12),
      (fam) => { const f = FACADES.get(FAM_MAT[fam] ?? ''); return f ? new THREE.Color(...f.wall) : new THREE.Color(0.6, 0.6, 0.58); },
      backdropRoofs(this.city.root.getObjectByName('backdrop') ?? new THREE.Group(), bjson.families, this.city.meta.bounds_m));
    this.scene.add(this.roofs.group);
    this.city.chunks.push(...this.roofs.chunks);
    // 花城汇's sunken court (gz_huacheng): its shopfront walls light its floor like any ground-floor shops
    const hc = await fetch('assets/tianhe/huacheng.json').then((r) => (r.ok ? r.json() : null)).catch(() => null) as
      { court: { bay: number; walls: { a: number[]; b: number[]; u0: number }[]; signs?: { c: number[]; n: number[]; w: number; h: number; entrance: boolean | 'link' }[] };
        mall?: (MallJson & { signs?: { c: number[]; n: number[]; w: number; h: number; entrance: boolean | 'link' }[] }) | null } | null;
    this.huacheng = hc;
    const allSigns = [...(hc?.court.signs ?? []), ...(hc?.mall?.signs ?? [])];
    if (allSigns.length) { this.huachengSigns = new HuachengSigns(allSigns); this.scene.add(this.huachengSigns.mesh); }
    if (hc?.mall) { this.mall = hc.mall; this.mallSigns = new MallSigns(hc.mall); this.scene.add(this.mallSigns.group); }
    const north = (hc as unknown as { north_half?: { fountain?: ConstructorParameters<typeof FountainShow>[0] } } | null)?.north_half;
    if (north?.fountain) { this.fountain = new FountainShow(north.fountain); this.scene.add(this.fountain.group); }
    const courtWalls = (hc?.court.walls ?? []).map((w) => ({ a: w.a, b: w.b, u0: w.u0, rnd: 0.5, bay: hc!.court.bay, litK: 4.0, top: 5.1, shut: 0.08 }));
    const shop = buildShopLight(bjson, this.city.meta.bounds_m, courtWalls);
    this.timings.shopEdges = shop.edges;
    this.timings.roofItems = this.roofs.counts.total ?? 0;
    this.timings.roofMs = Math.round(performance.now() - tr);
    this.furniture = new StreetFurniture(kit, this.city, walk, roadIndex, ground, this.metro);
    this.scene.add(this.furniture.group, this.metro.signs);
    this.metroMenu = new MetroMenu((metroJson as MetroData).line_colours);
    this.scene.add(this.pools.mesh, this.headlights.group);
    this.drones = new DroneShow();
    this.scene.add(this.drones.points);
    this.city.chunks.push(...this.furniture.chunks());
    const gltfs: GLTF[] = await Promise.all(charLoads);
    this.characters = gltfs.map((g, i) => new Character(CHARACTERS[i], g));
    for (const c of this.characters) this.scene.add(c.root);
    const [cars, carLods] = await Promise.all([Promise.all(carLoads), Promise.all(carLodLoads)]);
    text.textContent = '生成车流和路人…';
    await nextFrame();
    this.traffic = new Traffic(this.city.roads, cars, TRAFFIC_CARS, this.rng, (p) => this.sfx.horn(p, this.camera.position), carLods, MIX, ARTERIAL);
    this.traffic.viewer = this.camera.position;
    this.traffic.camera = this.camera;
    this.pedestrians = new Pedestrians(CHARACTERS, gltfs, this.rng, walk, WALKERS);
    this.pedestrians.ground = (p) => this.collision.groundHeight(this.groundProbe.copy(p).setY(p.y + 1.2), 3);
    this.pedestrians.setTraffic(this.traffic);
    this.apmPax = new ApmPassengers(CHARACTERS, gltfs, this.apm, this.apmTrains, this.metro, createSeededRandom(23));
    this.scene.add(this.apmPax.group);
    this.signals = new SignalLamps(this.traffic.roads, this.city.carriageway);
    this.scene.add(this.signals.group);
    this.props = buildProps(this.city, this.furniture, this.signals, this.collision);
    if (this.huacheng && (this.huacheng as unknown as HuachengLayout).seats) {
      this.plaza = new PlazaLife(gltfs, this.huacheng as unknown as HuachengLayout,
        (x, y, r) => !this.props.nearest(x, -y, r) && !this.metro.blocks(x, y, r * 0.5), createSeededRandom(2012));
      this.scene.add(this.plaza.group);
      this.plaza.fillNow(this.env.hour);                      // bodies built behind the loading screen
    }
    this.overlay = new BrainOverlay(this.brain, (id, out) => (id[0] === 'C' ? this.traffic.headOf(id, out) : this.pedestrians.headOf(id, out)));
    this.scene.add(this.pedestrians.group, this.traffic.group);
    this.driving = new Driving(this.collision);
    this.driving.props = this.props;
    const [bx0, by0, bx1, by1] = this.city.meta.bounds_m;
    this.driving.bounds = { x0: bx0, x1: bx1, z0: -by1, z1: -by0 };
    this.driving.snapToRoad = (p) => this.nearestLanePoint(p);
    this.ebike = new EBike(await ebikeLoad, await ebikeJson);
    this.scene.add(this.ebike.obj);
    this.bike = new Bike(this.ebike.obj, this.ebike.half, this.ebike.spec.wheelbase);
    this.bikes = new Riding(this.collision);
    this.bikes.props = this.props;
    this.bikes.bounds = this.driving.bounds;
    this.bikes.snapToRoad = (p) => this.nearestLanePoint(p);
    this.bikes.dry = this.driving.dry = (p) => this.huachengDry(p) || this.apm.under(p) > 0 || this.metro.underground(p);
    this.bikes.cars = (p, r) => this.carBodiesNear(p, r);
    this.police = new Police(this.traffic.roads, this.driving, vehicleTemplate(await policeLoad), {
      level: (level, reason) => {
        if (reason === 'report') this.hud.toast(`有人报警了！通缉 ${'★'.repeat(level)}`, 'bad', 2.4);
        else if (reason === 'lost') this.hud.toast(level > 0 ? `警察跟丢了一些 · ${'★'.repeat(level)}` : '甩掉警察了', 'good', 2.2);
      },
      busted: (driving) => {
        const fine = Math.min(this.jobs.cash, Math.max(50, Math.round(this.jobs.cash * 0.2)));
        this.jobs.cash -= fine;
        this.hud.showBusted(fine > 0 ? `被捕\n罚款 ¥${fine}` : '被捕', 3);
        const car = this.seat.get(this.active);
        if (driving && car) this.exitCar(this.characters[this.active], car);
        if (this.rider?.ch === this.active) { this.bike.speed = 0; this.getOffBike(); }
      },
    });
    this.scene.add(this.police.group);
    this.pedestrians.crimes = this.crimes;
    this.pedestrians.onReport = (crime) => { this.police.report(crime); };
    // the placeholder cast: onto the nearest sidewalk, each with a car at the kerb nearby
    this.characters.forEach((c, i) => {
      const at = this.snapToWalk(c.spec.spawn, true);
      c.placeAt(at.clone().setY(at.y + 0.3), c.spec.spawnHeading);
      if (i === 0) this.parkBike(c.root.position, c.spec.spawnHeading);   // Ah Jie his e-scooter, Qiqi the sports car, Uncle Keung his MPV
      else this.parkNear(at, [1, 4, 3][i]);
    });
    this.timings.totalLoadMs = Math.round(performance.now() - t0);
    this.controller = new Controller(this.collision);
    this.controller.props = this.props;
    this.rig = new CameraRig(this.camera, this.collision);
    this.rig.occluder = this.defaultOccluder = (o, d, max) => {
      const own = this.seat.get(this.active)?.obj;
      let best = this.props.raycast(o, d, max);
      for (const c of this.traffic.bodies) if (c.position.distanceToSquared(o) < 900) best = Math.min(best, raycastVehicle(c, o, d, max));
      for (const pc of this.parked) if (pc.obj !== own) best = Math.min(best, raycastVehicle(pc.obj, o, d, max));
      return best;
    };
    this.jobs = new Jobs(this.scene, this.rng, places);
    // the delivery game's places, people and orders
    const dj = await deliveryJson;
    storyShops(dj);
    this.delivery = new DeliveryWorld(await shopKitLoad, await shopKitJson, dj, (o, d, far) => this.collision.raycastDistance(o, d, far));
    this.scene.add(this.delivery.group);
    this.city.chunks.push(...this.delivery.chunks);
    this.delivery.addColliders(this.props);
    this.actors = new Actors(gltfs);
    this.scene.add(this.actors.group);
    this.dialogue = new Dialogue({ ...SPEAKERS });
    // voices: a line answering what the courier just said waits for him to finish; bubbles fade with distance
    // taking an answer gives the mouse back to the camera inside the key / click itself: browsers grant a pointer
    // lock asked for in a user gesture (the per-frame relock below stays as the fallback)
    const relockNow = () => { if (this.relock) this.input.requestLock(); };
    window.addEventListener('keydown', (e) => { if (this.dialogue.choosing && /^(Digit|Numpad)[1-4]$/.test(e.code)) relockNow(); }, true);
    document.querySelector('#dialog-choices')?.addEventListener('pointerdown', (e) => { if ((e.target as HTMLElement).closest('li')) relockNow(); });
    this.sfx.speakAnnouncement = (zh) => this.voice.announce(zh);
    this.dialogue.onLine = (who, text) => { this.voice.say(who, text, this.orders?.voiceVariant(who) ?? '', this.justChose); this.justChose = false; };
    this.dialogue.onChoice = (text) => { this.justChose = /^「/.test(text) && this.voice.say('ajie', text) > 0; };
    this.actors.onSay = (a, text) => {
      const who = a.name === '麦姐' ? 'maijie' : a.name === '发哥' ? 'fage' : a.tag === 'crew' ? a.id : a.tag === 'decoy' ? 'stranger'
        : a.tag === 'leaving' ? 'helper' : a.tag;
      // heard from where the character stands (not the camera behind): full within 5 m, gone by 11 m
      const d = a.root.position.distanceTo(this.characters[this.active].root.position);
      this.voice.bubble(who, text, a.female ? 'f' : 'm', Math.min(1, Math.max(0, (11 - d) / 6)));
    };
    this.photo = new PhotoMode(this.camera, this.collision);
    this.orders = new Orders(this.jobs, this.delivery, this.actors, this.dialogue, this.photo, this.jobs.drops, this.rng);
    this.orders.notify = (n) => { this.hud.notify(n); this.sfx.ping(); };
    this.orders.toast = (t, tone = '', sec = 2.4) => { if (t) this.hud.toast(t, tone, sec); };
    this.orders.stamina = () => { const c = this.characters[this.active]; c.stamina = 1; c.exhausted = false; };
    this.orders.liftBike = () => { if (this.bike.crashed) this.bikes.rightUp(this.bike, true); };
    this.orders.eye = () => {
      const c = this.characters[this.active];
      c.root.updateMatrixWorld(true);
      const head = c.model.getObjectByName('Head');
      const p = head ? new THREE.Vector3().setFromMatrixPosition(head.matrixWorld) : c.root.position.clone().setY(c.root.position.y + 1.55);
      return p.add(new THREE.Vector3(Math.sin(c.root.rotation.y), 0.05, Math.cos(c.root.rotation.y)).multiplyScalar(0.15));
    };
    this.orders.raycast = (o, d, far) => this.collision.raycastDistance(o, d, far);
    this.orders.card = (t, sub) => this.chapterCard(t, sub);
    this.orders.walkable = (p) => {
      const lane = this.nearestLanePoint(p);
      if (lane && Math.hypot(lane.pos.x - p.x, lane.pos.z - p.z) < 2.9) return false;
      const g = this.collision.groundHeight(p.clone().setY(p.y + 1.2), 3);
      if (g === null || Math.abs(g - p.y) > 0.35) return false;
      p.y = g;
      // street props by their footprint; a street tree by its pit (about 1.4 m square around the trunk), not the trunk
      return !this.props.nearest(p.x, p.z, 0.55) && !this.props.nearest(p.x, p.z, 1.1, (k) => k === 'tree');
    };
    this.busStops();
    this.placeStalls(places as { name: string; role: string; cat: string; pos: number[] }[]);
    this.placeStation();
    // the square's people keep off the courier station, Ah Jie's start and his parked e-bike
    if (this.plaza) {
      const st = new THREE.Vector3(this.timings.stationX ?? 0, 0, this.timings.stationZ ?? 0);
      for (const [p, r] of [[st, 11], [this.characters[0].root.position, 9], [this.ebike.obj.position, 4]] as [THREE.Vector3, number][]) this.plaza.keepClear(p.x, -p.z, r);
    }
    this.orders.picked = () => { if (this.ebike.obj.position.distanceTo(this.characters[this.active].root.position) < 8) this.ebike.openLid(); };
    for (const c of this.characters) this.controller.update(c, { ...this.intent, move: new THREE.Vector2() }, 0, 1 / 60);
    this.setActive(0, false);
    this.safe.copy(this.characters[0].root.position);
    this.pipeline.compile(this.scene, this.camera);
    // upload every texture now, behind the loading screen: the landmark kits are 2k maps with mip chains, and
    // uploading them the first time they come into view stalls that frame by tens of milliseconds
    const seen = new Set<THREE.Texture>();
    this.scene.traverse((o) => {
      const mats = (o as THREE.Mesh).material;
      for (const m of (Array.isArray(mats) ? mats : mats ? [mats] : []) as THREE.Material[]) {
        for (const v of Object.values(m)) if (v instanceof THREE.Texture && !seen.has(v)) { seen.add(v); this.renderer.initTexture(v); }
      }
    });
    this.timings.texturesUploaded = seen.size;
    this.ready = true;
    draco.dispose();
    el('#loading').classList.add('done');
    const help = el('#help');
    help.hidden = false;
    el('#start').addEventListener('click', () => this.begin());
    this.loop.start();
  }

  /** Nearest walkway node to a point (three.js), as a three.js position. */
  /**
   * Light and draw for where the camera is: indoor light under the street (entrance stairs and halls, the APM, 花城汇
   * B1); the underground drawn only from under the pavement, beside an APM entrance or from 花城汇's court and mall
   * (which open into the 花城大道 concourse); deep inside it the city, its traffic and the weather are not drawn --
   * except where that concourse looks out through 花城汇's doors. The river plane (it would cross the concourse and the
   * mall at -2.8 m) is hidden below ground.
   */
  private underground(cam: THREE.Vector3): { inApm: number; underK: number } {
    const inApm = this.apm.under(cam);
    const mall = this.mallAt(cam);
    const underK = Math.max(this.metro.underFactor(cam), inApm, mall.k);
    this.env.setUnder(underK);
    this.pipeline.apmFloors = underK > 0.3;
    this.apm.group.visible = this.apmTrains.group.visible = underK > 0 || this.metro.nearApmExit(cam, 35) || mall.near;
    const surface = inApm < 1 || mall.seesOut;
    for (const g of [this.city.root, this.nearFuture.group, this.facades.group, this.roofs.group, this.traffic.group, this.pedestrians.group, this.police.group]) g.visible = surface;
    const water = this.city.root.getObjectByName('water');
    if (water) water.visible = !(inApm > 0 || mall.k > 0);
    return { inApm, underK };
  }

  /**
   * 花城汇 B1 (gz_mall) at a three.js position: k 0 outdoors .. 1 deep in its rooms (indoor light; 0 at the court's
   * doors, rising through the link and the vestibule, falling again up the north escalators); near: the court or the
   * mall, from where the 花城大道 concourse shows through a door (draw the APM); seesOut: inside that concourse's
   * unpaid ends by the mall's doors, from where the court and the corridor show (keep the city drawn).
   */
  private mallAt(p: THREE.Vector3): { k: number; near: boolean; seesOut: boolean } {
    const m = this.mall;
    if (!m) return { k: 0, near: false, seesOut: false };
    const bx = p.x, by = -p.z, bz = p.y;
    const inR = (r: number[], pad = 0) => bx > r[0] - pad && bx < r[2] + pad && by > r[1] - pad && by < r[3] + pad;
    let k = 0;
    if (bz < m.z + m.h + 0.4 && bz > m.z - 1) {
      if (inR(m.rect)) k = 1;
      else if (inR(m.xlink)) k = 1;
      else if (inR(m.link)) k = THREE.MathUtils.clamp((m.link[2] - bx) / (m.link[2] - m.link[0]), 0, 1);
      else if (inR(m.vest)) k = THREE.MathUtils.clamp((by - m.vest[1]) / (m.vest[3] - m.vest[1]), 0.3, 1);
    }
    if (inR(m.well) && bz > m.z - 1) k = Math.max(k, THREE.MathUtils.clamp(1 - (by - m.well[1]) / 6, 0, 1) * (bz < m.z + m.h ? 1 : 0.5));
    const court = this.huacheng ? (this.huacheng.court as unknown as { rect: number[] }).rect : null;
    const near = k > 0 || (!!court && bz < 0.5 && bx > court[0] - 4 && bx < court[2] + 4 && by > court[1] - 4 && by < court[3] + 6);
    let seesOut = false;
    const st = this.apm.stations.find((s) => s.key === 'huacheng');
    if (st && bz < m.z + 4) {
      const [u, v] = this.apm.toFrame(st, bx, by);
      seesOut = Math.abs(v) < 10.5 && Math.abs(u) < 33 && (u < -14 || (u > 8 && u < 30));
    }
    return { k, near, seesOut };
  }

  /** The nearest walk-graph node to p; `alongEdges`: or the nearest point along any edge (the characters' starts). */
  private snapToWalk(p: THREE.Vector3, alongEdges = false): THREE.Vector3 {
    const bx = p.x, by = -p.z;
    let best = this.walk.nodes[0], bd = Infinity;
    for (const n of this.walk.nodes) { const d = (n[0] - bx) ** 2 + (n[1] - by) ** 2; if (d < bd) { bd = d; best = n; } }
    if (!alongEdges) return fromBlender(best[0], best[1], best[2]);
    // the nearest point along an edge, not only a node: nodes are junctions, and on 花城广场 the nearest one to Ah
    // Jie's spawn was 72 m off (beside the museum) while a footway passes 15 m from it
    let ex = best[0], ey = best[1], ez = best[2];
    for (const e of this.walk.edges) {
      if (e.kind === 'cross') continue;
      const za = this.walk.nodes[e.a][2], zb = this.walk.nodes[e.b][2];
      if (Math.abs(za - zb) > 0.3 || za < -1) continue;             // not the stairs down into the court
      for (let i = 0; i + 1 < e.pts.length; i++) {
        const [ax, ay] = e.pts[i], [cx, cy] = e.pts[i + 1];
        const dx = cx - ax, dy = cy - ay, L2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((bx - ax) * dx + (by - ay) * dy) / L2));
        const qx = ax + dx * t, qy = ay + dy * t, d = (qx - bx) ** 2 + (qy - by) ** 2;
        if (d < bd) { bd = d; ex = qx; ey = qy; ez = za; }
      }
    }
    return fromBlender(ex, ey, ez);
  }

  // ------------------------------------------------------------------------------------------ the e-bike
  /** The e-bike on the pavement by the nearest quiet lane, parked at an angle the way couriers leave them. */
  /**
   * Park the e-bike for a character standing at `p` facing `facing` (root yaw): first choice right beside them, in
   * front and to one side so the opening camera sees it, on the same level and clear of walls and street props;
   * otherwise at the kerb of the nearest quiet lane.
   */
  parkBike(p: THREE.Vector3, facing?: number): void {
    const o = this.ebike.obj, b = this.bike;
    if (facing !== undefined) {
      const f = new THREE.Vector3(Math.sin(facing), 0, Math.cos(facing)), r = new THREE.Vector3(-Math.cos(facing), 0, Math.sin(facing));
      const heading = facing + Math.PI + 0.45;
      const seg = new THREE.Line3(), corr = new THREE.Vector3(), q = new THREE.Vector3();
      const fw = new THREE.Vector3(-Math.sin(heading), 0, -Math.cos(heading));
      for (const [a, c] of [[2.4, 1.3], [2.4, -1.3], [1.4, 1.7], [1.4, -1.7], [3.4, 1.6], [3.4, -1.6], [0.2, 1.9], [0.2, -1.9]]) {
        q.copy(p).addScaledVector(f, a).addScaledVector(r, c);
        const g = this.collision.groundHeight(q.clone().setY(p.y + 1.5), 3);
        if (g === null || Math.abs(g - p.y) > 0.35 || g < WATER_Y + 1) continue;
        q.y = g;
        seg.start.copy(q).addScaledVector(fw, -0.75).setY(g + 0.6); seg.end.copy(q).addScaledVector(fw, 0.75).setY(g + 0.6);
        if (this.collision.resolveCapsule(seg, 0.4, corr).lengthSq() > 1e-6) continue;
        if (this.props.resolveBox(q.clone(), 0.45, b.half.y + 0.2, heading, g + 0.1, g + 1.3)) continue;
        o.position.copy(q);
        b.heading = heading;
        this.finishParking();
        return;
      }
    }
    let best: { pos: THREE.Vector3; tan: THREE.Vector3; w: number } | null = null, bd = 60;
    const pos = new THREE.Vector3(), tan = new THREE.Vector3();
    for (const lane of this.traffic.roads.lanesNear(p)) {
      if (lane.index !== lane.count - 1 || lane.path.length < 20 || lane.from.z > 0.5 || lane.to.z > 0.5) continue;
      for (let s = 6; s < lane.path.length - 6; s += 2) {
        lane.path.at(s, pos, tan);
        const d = pos.distanceTo(p);
        if (d < bd) { bd = d; best = { pos: pos.clone(), tan: tan.clone(), w: lane.width }; }
      }
    }
    if (best) {
      const right = new THREE.Vector3(-best.tan.z, 0, best.tan.x);
      o.position.copy(best.pos).addScaledVector(right, best.w / 2 + 1.1);
      b.heading = Math.atan2(-best.tan.x, -best.tan.z) + 0.5;
    } else { o.position.copy(p).add(new THREE.Vector3(1.5, 0, 0)); b.heading = 0; }
    const g = this.collision.groundHeight(o.position.clone().setY(o.position.y + 2), 4);
    if (g !== null) o.position.y = g;
    this.finishParking();
  }

  private finishParking(): void {
    const o = this.ebike.obj, b = this.bike;
    if (b.crashed) this.bikes.rightUp(b);
    o.rotation.set(0, b.heading, 0, 'YXZ');
    b.speed = 0; b.vlat = 0; b.vy = 0; b.lean = 0; b.leanV = 0; b.pitch = 0; b.targetH = NaN; b.airborne = false;
    b.prev.copy(o.position);
    this.ebike.pose(0, 0, 0, 0, false, 0);
  }

  private bikeReach(p: THREE.Vector3): boolean {
    const q = this.ebike.obj.position;
    return Math.hypot(q.x - p.x, q.z - p.z) < 1.9 && Math.abs(q.y - p.y) < 1.5;
  }

  private getOnBike(): void {
    const ch = this.characters[this.active];
    if (this.bike.crashed) this.bikes.rightUp(this.bike, true);
    let pose = this.riderPoses.get(this.active);
    if (!pose) {
      // measure the hips standing, before the first mount
      ch.root.rotation.set(0, ch.root.rotation.y, 0);
      pose = new RiderPose(ch);
      this.riderPoses.set(this.active, pose);
    }
    this.rider = { ch: this.active, pose, mount: 0, dir: 1, foot: 1 };
    this.bike.speed = 0;
    if (!this.hud.isToasting()) this.hud.toast(`${ch.spec.name} 骑上电鸡 · W 加速 · S 刹车 · A/D 转向 · 空格 后刹甩尾 · Q 喇叭 · F 下车`, '', 3.2);
  }

  private getOffBike(): void {
    if (!this.rider || this.rider.dir === -1) return;
    if (Math.abs(this.bike.speed) > 2.5) { this.hud.toast('先减速再下车', 'bad', 1.2); return; }
    this.rider.dir = -1;
  }

  /** Every frame: the bike's physics (ridden, or rolling / lying on its own), mounting, the thrown rider. */
  private updateBike(dt: number, controllable: boolean): void {
    const b = this.bike, r = this.rider;
    const active = r?.ch === this.active;
    const mounted = !!r && r.mount >= 1 && r.dir >= 0;
    const input = mounted && active && controllable
      ? { throttle: this.pilotBike ? this.pilotBike.throttle : this.moveVec.y, steer: this.pilotBike ? this.pilotBike.steer : this.moveVec.x, brake: this.pilotBike ? this.pilotBike.brake : this.input.handbrake }
      : { throttle: 0, steer: 0, brake: true };
    const moving = b.crashed || Math.abs(b.speed) > 0.01 || b.airborne || !!r || Math.abs(b.lean) > 0.01;
    const x0 = b.obj.position.x, z0 = b.obj.position.z;
    if (moving) this.bikes.update(b, input, dt);
    const dist = Math.hypot(b.obj.position.x - x0, b.obj.position.z - z0) * Math.sign(b.speed || 1);
    // getting on / off
    if (r) {
      if (r.dir !== 0) {
        r.mount += r.dir * dt / (r.dir > 0 ? 0.45 : 0.4);
        if (r.mount >= 1) { r.mount = 1; r.dir = 0; if (r.ch === this.active) this.sfx.ebikeOn(); }
        if (r.mount <= 0) {
          const c = this.characters[r.ch];
          const at = r.pose.besidePoint(this.ebike, new THREE.Vector3());
          c.root.rotation.set(0, 0, 0);
          c.placeAt(at.setY(at.y + 0.05), b.heading + Math.PI);
          if (r.ch === this.active) this.rig.snap(c.root.position, c.heading);
          this.rider = null;
        }
      }
      const stopped = Math.abs(b.speed) < 0.8 && !b.airborne;
      if (this.rider) this.rider.foot += ((stopped || this.rider.dir !== 0 ? 1 : 0) - this.rider.foot) * Math.min(1, dt * 7);
    }
    // nobody on it: a car that drives into it knocks it over, a slow one just shoves it
    if (!r && !b.crashed) {
      const me = { x: b.obj.position.x, z: b.obj.position.z, hx: b.half.x * 0.7, hz: b.half.y * 0.9, h: b.heading };
      for (const c of this.carBodiesNear(b.obj.position, 7)) {
        const k = obbContact(me, c);
        if (!k) continue;
        if (Math.abs(c.speed) > 1.5) {
          this.bikes.knockOver(b, new THREE.Vector3(c.fwdX * c.speed, 0, c.fwdZ * c.speed));
          if (b.obj.position.distanceToSquared(this.camera.position) < 900) this.sfx.crunch(Math.min(1, Math.abs(c.speed) / 10));
          break;
        }
        b.obj.position.x += k.nx * k.depth; b.obj.position.z += k.nz * k.depth;
      }
    }
    // thrown off
    if (b.crashed && this.rider) { this.sfx.crunch(Math.min(1, (b.crash?.speed ?? 6) / 10)); this.throwRider(); }
    this.sfx.setScrape(b.crashed ? b.slide.length() / 8 : b.skidding ? Math.min(0.7, Math.abs(b.vlat) / 5) : 0);
    if (this.thrown) this.updateThrown(dt);
    b.obj.updateMatrixWorld();
    // parts, lamps, the phone
    const standTarget = this.rider && this.rider.mount > 0.4 && this.rider.dir >= 0 ? 0 : 1;
    this.ebike.standK += (standTarget - this.ebike.standK) * Math.min(1, dt * 8);
    const indicator = mounted && Math.abs(b.speed) < 5 && Math.abs(input.steer) > 0.5 ? Math.sign(input.steer) : 0;
    this.ebike.pose(b.steer, dist, dt, this.env.night, b.braking, indicator, b.skidding);
    if (b.obj.position.distanceToSquared(this.camera.position) < 400) {
      const J = this.jobs;
      const target = J.phase === 'carrying' ? J.drop : J.pickup;
      this.ebike.updatePhone(dt, { phase: J.phase === 'carrying' ? 'carrying' : 'offer', place: J.phase === 'none' ? '等待派单…' : target.name, dist: J.phase === 'none' ? 0 : target.pos.distanceTo(b.obj.position), timeLeft: J.timeLeft, cash: J.cash, delivered: J.delivered, rating: J.rating, condition: J.condition });
    }
    if (!active) { this.sfx.setEbike(0, 0, 0); return; }
    // riding: people in the way, rescues, landings, the horn, the motor
    if (mounted && Math.abs(b.speed) > 1) {
      const knocked = this.pedestrians.hitByCar({ obj: b.obj, half: b.half, speed: b.speed });
      if (knocked.length) {
        this.facts.crash = { pos: knocked[0].pos, at: performance.now() / 1000, victim: 'person' };
        this.crime('hit_person', knocked[0].pos);
        b.speed *= 0.6;
        if (!this.hud.isToasting()) this.hud.toast('撞到路人了', 'bad', 1.4);
      }
    }
    if (b.rescued) this.hud.toast('连人带车掉进珠江……捞回岸上', 'bad', 2);
    else if (b.atEdge && !this.hud.isToasting()) this.hud.toast('前方无路 · 已到地图边界', '', 1.2);
    if (b.landing > 2.5) this.rig.shake(Math.min(0.7, (b.landing - 2.5) / 8));
    if (b.landing > 4) this.foodJolt((b.landing - 4) * 0.05);
    b.landing = 0;
    if (b.knock > 2) this.foodJolt((b.knock - 2) * 0.04);
    b.knock = 0;
    const horn = this.input.held('KeyQ');
    if (horn && !this.hornHeld && mounted) this.sfx.ebikeHorn();
    this.hornHeld = horn;
    this.sfx.setEbike(mounted ? 1 : 0, b.speed, input.throttle);
  }

  /** The platform talking: pickup, delivery (pay, tip, the customer, Xiaozhun tightening the clock), failure. */
  private jobToast(ev: JobEvent): void {
    const J = this.jobs;
    if (ev.type === 'picked') { this.hud.toast(`已取餐 · 送往 ${J.drop.name} · 小准限时 ${Math.floor(J.timeLimit / 60)}:${String(J.timeLimit % 60).padStart(2, '0')}`, 'good', 2.6); return; }
    if (ev.type === 'failed') { this.hud.toast(`超时 · ${ev.place} 的单子被取消 · 评分 −0.05 · 小准：请您合理规划路线`, 'bad', 3.4); return; }
    if (ev.type === 'spilled') { this.hud.toast(`餐洒光了 · ${ev.place} 的单子被取消 · 评分 −0.08`, 'bad', 3.4); return; }
    const c = ev.condition ?? 1;
    let line = `送达 ${ev.place} · +¥${ev.reward}`;
    if (ev.tip) line += ` · 打赏 ¥${ev.tip}`;
    if (c < 0.4) line += ' · 顾客差评：「汤全洒了」';
    else if (c < 0.7) line += ' · 顾客：「怎么洒了一半」';
    else if (ev.early) line += ` · 提前 ${ev.saved} 秒 · 小准已为您优化后续时限 −3%`;
    this.hud.toast(line, c < 0.7 ? 'bad' : 'good', 3.6);
  }

  /** A knock to the food in the box (only while carrying an order); `lead` goes in front of the message. */
  private foodJolt(amount: number, lead = ''): void {
    const J = this.jobs;
    if (J.phase !== 'carrying' || amount < 0.01) { if (lead) this.hud.toast(lead, 'bad', 2); return; }
    if (J.jolt(amount)) { this.jobToast(J.spill()); this.orders.cancel(); return; }
    const msg = `餐品完好度 ${Math.round(J.condition * 100)}%`;
    if (lead) this.hud.toast(`${lead} · ${msg}`, 'bad', 2.4);
    else if (amount >= 0.04) this.hud.toast(`小准：检测到餐箱剧烈晃动 · ${msg}`, 'bad', 1.8);
  }

  private orderPrompt: string | null = null;
  private readonly photoMove = new THREE.Vector2();
  private relock = false;
  /** the bag in the courier's hand while walking an order to the door */
  private heldBag: THREE.Object3D | null = null;

  /**
   * A Guangzhou stop board at every bus stop that takes orders: about a metre onto the pavement from the kerb,
   * facing along the road, clear of the street furniture; the order's drop point moves to where people wait by it.
   */
  private busStops(): void {
    const list: { pos: THREE.Vector3; yaw: number; name: string }[] = [];
    const places: { place: { pos: THREE.Vector3 }; i: number }[] = [];
    this.jobs.drops.forEach((d) => {
      if (d.cat !== 'bus') return;
      const lane = this.nearestLanePoint(d.pos);
      if (!lane) return;
      const to = d.pos.clone().sub(lane.pos).setY(0);
      const L = to.length();
      if (L < 1.5) return;
      to.divideScalar(L);
      const along = new THREE.Vector3(-Math.sin(lane.heading), 0, -Math.cos(lane.heading));
      let pos: THREE.Vector3 | null = null;
      for (const s of [0, 1.6, -1.6, 3.2, -3.2, 4.8, -4.8, 6.4, -6.4]) {
        const p = lane.pos.clone().addScaledVector(to, Math.min(L - 0.2, 2.7)).addScaledVector(along, s);
        const g = this.collision.groundHeight(p.clone().setY(d.pos.y + 1.5), 4);
        if (g === null || Math.abs(g - d.pos.y) > 0.4) continue;
        if (this.props.nearest(p.x, p.z, 0.9)) continue;
        if (this.furniture.crossings.near(p.x, -p.z, ZEBRA_HALF + 1.2)) continue;   // not at the mouth of a zebra
        // clear of every lane (a road with a parallel carriageway has more than one)
        const ln = this.nearestLanePoint(p);
        if (ln && Math.hypot(ln.pos.x - p.x, ln.pos.z - p.z) < 2.4) continue;
        p.y = g; pos = p; break;
      }
      if (!pos) return;
      places.push({ place: d, i: list.length });
      list.push({ pos, yaw: lane.heading, name: d.name });
    });
    const waits = this.delivery.addBusSigns(list);
    list.forEach((st) => this.props.addBox(st.pos.x, st.pos.z, st.yaw, 0, 0, 0.6, 0.12, st.pos.y, st.pos.y + 2.9, 'shop'));
    for (const { place, i } of places) place.pos.copy(waits[i]);
    this.timings.busSigns = list.length;
  }

  /**
   * Street food stalls for the pickups with no shop wall: the OSM shops gz_delivery.py found no facade for, and the
   * ones whose facade the game's collision does not have. Each goes on the pavement 2.2-2.8 m off a walk line, on
   * level ground, clear of walls, street furniture, lanes, metro exits and the other delivery places, its long side
   * along the line and its customer side (kit +y) facing it.
   */
  private placeStalls(places: { name: string; role: string; cat: string; pos: number[] }[]): void {
    const KIND: Record<string, ShopKind> = { restaurant: 'restaurant', fast_food: 'restaurant', mall: 'restaurant', cafe: 'tea', bakery: 'tea', bar: 'tea',
      convenience: 'convenience', supermarket: 'convenience', shop: 'shop' };
    const have = new Set(this.delivery.places.filter((p) => p.kind === 'shop').map((p) => p.name));
    const want: { name: string; kind: ShopKind; x: number; y: number; z: number }[] = [];
    const notACart = /商场|展厅|汽车|广场|中心/;                 // a mall or a car showroom does not sell from a tricycle
    for (const p of places) {
      if (p.role !== 'pickup' || have.has(p.name) || notACart.test(p.name)) continue;
      have.add(p.name);
      want.push({ name: p.name, kind: KIND[p.cat] ?? 'shop', x: p.pos[0], y: p.pos[1], z: p.pos[2] });
    }
    for (const r of this.delivery.wallless) if (!have.has(r.name) && !notACart.test(r.name)) { have.add(r.name); want.push({ name: r.name, kind: r.kind, x: r.a[0], y: r.a[1], z: r.z }); }
    const taken = this.delivery.places.map((p) => p.pos.clone());
    const seg = new THREE.Line3(), corr = new THREE.Vector3(), v = new THREE.Vector3();
    const out: { name: string; kind: ShopKind; pos: THREE.Vector3; yaw: number }[] = [];
    for (const w of want) {
      // candidates: points every 2 m on the walk lines within 45 m, either side
      const cands: { d: number; pos: THREE.Vector3; yaw: number }[] = [];
      for (const e of this.walk.edges) {
        if ((e.kind !== 'side' && e.kind !== 'foot') || e.pts.length < 2) continue;
        let carry = 1;                                  // samples every 2 m along the whole line, across its short segments
        for (let k = 1; k < e.pts.length; k++) {
          const [ax, ay] = e.pts[k - 1], [bx, by] = e.pts[k];
          const L = Math.hypot(bx - ax, by - ay);
          const t0 = carry;
          carry = ((carry - L) % 2 + 2) % 2;
          if (L < 0.05) continue;
          if (Math.min(ax, bx) > w.x + 60 || Math.max(ax, bx) < w.x - 60 || Math.min(ay, by) > w.y + 60 || Math.max(ay, by) < w.y - 60) continue;
          const tx = (bx - ax) / L, ty = (by - ay) / L;
          for (let t = t0; t < L; t += 2) {
            const px = ax + tx * t, py = ay + ty * t;
            const dd = Math.hypot(px - w.x, py - w.y);
            if (dd > 60) continue;
            for (const side of [1, -1]) for (const off of [2.2, 2.7, 3.3]) {
              const cx = px - ty * side * off, cy = py + tx * side * off;
              // the front (kit +y) looks back at the walk line: Blender (ty*side, -tx*side) -> three (x, -y)
              const fx = ty * side, fz = tx * side;
              cands.push({ d: Math.hypot(cx - w.x, cy - w.y) + off * 0.5, pos: fromBlender(cx, cy, w.z), yaw: Math.atan2(-fx, -fz) });
            }
          }
        }
      }
      cands.sort((a, b) => a.d - b.d);
      const ok = (c: { pos: THREE.Vector3; yaw: number }) => {
        const g0 = this.collision.groundHeight(v.copy(c.pos).setY(c.pos.y + 2), 5);
        if (g0 === null) return false;
        if (taken.some((t) => t.distanceTo(c.pos) < 8) || this.metro.at(c.pos)) return false;
        const co = Math.cos(c.yaw), sn = Math.sin(c.yaw);
        for (const lx of [-1.7, -0.6, 0.5, 1.6]) for (const ly of [-0.65, 0.65, 1.25]) {
          // kit-local (lx, ly) -> three: x = lx cos - (-ly) sin..., the kit +y is three local -z
          const x = c.pos.x + lx * co - ly * sn, z = c.pos.z - lx * sn - ly * co;
          const g = this.collision.groundHeight(v.set(x, g0 + 2, z), 5);
          if (g === null || Math.abs(g - g0) > 0.18) return false;
          if (this.props.nearest(x, z, 0.55)) return false;
          seg.start.set(x, g + 0.5, z); seg.end.set(x, g + 2.2, z);
          this.collision.resolveCapsule(seg, 0.4, corr);
          if (corr.lengthSq() > 1e-4) return false;
          const lane = this.nearestLanePoint(v.set(x, g, z));
          if (lane && Math.hypot(lane.pos.x - x, lane.pos.z - z) < 3.0) return false;
        }
        c.pos.y = g0;
        return true;
      };
      const c = cands.find(ok);
      if (!c) continue;
      taken.push(c.pos.clone());
      out.push({ name: w.name, kind: w.kind, pos: c.pos, yaw: c.yaw });
    }
    this.delivery.addStalls(out, this.props);
    this.timings.stalls = out.length;
    this.timings.stallsWanted = want.length;
  }

  /**
   * The Zhunshida courier station near Ah Jie's spawn (花城广场南 · 外卖站): the nearest open, level patch of paving
   * (no walls, no street furniture, off the road, clear of shops), its front toward the spawn. Couriers wait there.
   */
  private placeStation(): void {
    const spawn = this.characters[0].root.position.clone();
    this.timings.spawnX = Math.round(spawn.x); this.timings.spawnZ = Math.round(spawn.z);
    const g0 = this.collision.groundHeight(spawn.clone().setY(spawn.y + 2), 5) ?? spawn.y;
    const seg = new THREE.Line3(), corr = new THREE.Vector3();
    const ok = (pos: THREE.Vector3, yaw: number) => {
      const c = Math.cos(yaw), sn = Math.sin(yaw);
      for (let lx = -3.3; lx <= 4.5; lx += 1.1) for (let ly = -2.5; ly <= 5.6; ly += 1.15) {
        const x = pos.x + lx * c - ly * sn, z = pos.z - lx * sn - ly * c;
        const g = this.collision.groundHeight(new THREE.Vector3(x, g0 + 2, z), 5);
        if (g === null || Math.abs(g - g0) > 0.22) return false;
        if (this.props.nearest(x, z, 0.8)) return false;
        seg.start.set(x, g + 0.5, z); seg.end.set(x, g + 2.4, z);
        this.collision.resolveCapsule(seg, 0.45, corr);
        if (corr.lengthSq() > 1e-4) return false;
        const lane = this.nearestLanePoint(new THREE.Vector3(x, g, z));
        if (lane && Math.hypot(lane.pos.x - x, lane.pos.z - z) < 4.5) return false;
      }
      return !this.delivery.places.some((p) => p.pos.distanceTo(pos) < 9) && !this.metro.at(pos);
    };
    for (let r = 10; r <= 40; r += 2.5) {
      for (let k = 0; k < 28; k++) {
        const a = (k / 28) * Math.PI * 2;
        const pos = spawn.clone().add(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
        const d = spawn.clone().sub(pos);
        const yaw = Math.atan2(-d.x, -d.z);
        if (!ok(pos, yaw)) continue;
        pos.y = g0;
        const pts = this.delivery.addStation(pos, yaw, this.ebike.obj.children[0] ?? null, this.props, () => this.jobs.rating);
        this.orders.setupStation(pts, yaw);
        this.timings.stationX = Math.round(pos.x); this.timings.stationZ = Math.round(pos.z);
        return;
      }
    }
  }

  /** What walkers step around this frame: the protagonists on foot, the e-bike (ridden or parked), the delivery game's people. */
  private fillBlockers(car: DriveCar | null, bikeAt: THREE.Vector3 | null): void {
    const B = this.pedestrians.blockers;
    B.length = 0;
    for (const [i, c] of this.characters.entries()) {
      if (this.seat.get(i) || this.rider?.ch === i) continue;
      B.push({ p: c.root.position, r: 0.32, player: i === this.active });
    }
    if (bikeAt) B.push({ p: bikeAt, r: 0.85, player: true });
    else if (!car) B.push({ p: this.ebike.obj.position, r: 0.85 });
    for (const a of this.actors.list) if (!a.gone) B.push({ p: a.root.position, r: 0.32 });
    for (const p of this.delivery.walkBlockers) B.push(p);
  }

  /** On foot with an order: the bag hangs from the right hand. */
  private carryBag(c: Character, on: boolean): void {
    if (!on) { if (this.heldBag) this.heldBag.visible = false; return; }
    if (!this.heldBag) { this.heldBag = this.delivery.bag(); this.scene.add(this.heldBag); }
    const hand = c.model.getObjectByName('R_Hand');
    if (!hand) return;
    c.root.updateMatrixWorld(true);
    const p = new THREE.Vector3().setFromMatrixPosition(hand.matrixWorld);
    this.heldBag.visible = true;
    this.heldBag.position.set(p.x, p.y - 0.33, p.z);
    this.heldBag.rotation.set(0, c.root.rotation.y + Math.PI / 2, 0);
  }

  /** A full-screen title card: the chapter's name, fading in and out. */
  private chapterCard(title: string, sub: string): void {
    const el2 = document.querySelector('#chapter-card') as HTMLElement;
    (el2.querySelector('b') as HTMLElement).textContent = title;
    (el2.querySelector('span') as HTMLElement).textContent = sub;
    el2.classList.remove('show');
    void el2.offsetWidth;
    el2.classList.add('show');
  }

  /** QA autopilot for the bike (replaces the keys while set). */
  pilotBike: { throttle: number; steer: number; brake: boolean } | null = null;

  private throwRider(): void {
    const r = this.rider!, b = this.bike;
    const c = this.characters[r.ch];
    const sp = b.crash?.speed ?? 0;
    // the bike stops dead, the rider carries on: most of the speed, up and over what was hit
    const vel = (b.crash?.dir ?? b.forward.multiplyScalar(b.speed)).clone().setY(0).multiplyScalar(0.85);
    vel.y = THREE.MathUtils.clamp(2.6 + sp * (b.crash?.car ? 0.4 : 0.26), 3, 7.5);
    c.root.updateMatrixWorld(true);
    const pos = c.root.localToWorld(new THREE.Vector3(0, r.pose.hipH, 0));
    const yaw = Math.hypot(vel.x, vel.z) > 0.5 ? Math.atan2(vel.x, vel.z) : b.heading + Math.PI;
    this.thrown = { ch: r.ch, pos, vel, t: 0, phase: 'air', spin: 5 + sp * 0.4 + Math.random() * 2, tilt: 0.25, yaw, hipH: r.pose.hipH, feet: new THREE.Vector3(), roof: false, lie: Math.PI / 2 };
    this.rider = null;
    c.grounded = false;
    if (r.ch === this.active) {
      if (Math.random() < 0.7) { const bp = b.obj.position.clone(), rp = pos.clone().setY(b.obj.position.y); setTimeout(() => this.orders.crashHelp(bp, rp), 1500); }
      this.foodJolt(0.25 + sp * 0.03, `摔车了！（${Math.round(sp * 3.6)} km/h）`);
      this.rig.shake(0.9);
    }
  }

  /**
   * The thrown body as one point at the hips (radius 0.3): flies (tumbling forward), bounces off walls and the sides
   * of cars, lands on the ground or a car's roof, slides face down, lies still for a moment, gets up. Off a roof
   * edge it falls again. Sub-stepped at 120 Hz: it moves fast.
   */
  private updateThrown(dt: number): void {
    const t = this.thrown!;
    t.t += dt;
    const n = Math.max(1, Math.ceil(dt * 120 - 1e-3));
    for (let i = 0; i < n && this.thrown; i++) this.thrownStep(t, dt / n);
  }

  private thrownStep(t: NonNullable<Game['thrown']>, dt: number): void {
    const p = t.pos, R = 0.3, LIE = 0.14;
    if (t.phase === 'lying') {
      if (t.t > 1.2) {
        t.phase = 'up'; t.t = 0;
        const k = Math.sign(t.lie) * t.hipH;        // the feet are behind the hips face down, ahead of them on its back
        t.feet.set(p.x - Math.sin(t.yaw) * k, p.y - LIE, p.z - Math.cos(t.yaw) * k);
      }
      return;
    }
    if (t.phase === 'up') {
      if (t.t > 0.8) {
        const c = this.characters[t.ch];
        c.root.rotation.set(0, 0, 0);
        c.placeAt(t.feet.clone().setY(t.feet.y + 0.05), t.yaw);
        c.grounded = true;
        this.thrown = null;
      }
      return;
    }
    if (t.phase === 'air') t.vel.y += PHYSICS.gravity * dt;
    else {
      const s = Math.hypot(t.vel.x, t.vel.z);
      const k = s > 0 ? Math.max(t.roof ? Math.min(s, 1.5) : 0, s - 8.5 * dt) / s : 0;   // never stops on a roof
      t.vel.x *= k; t.vel.z *= k; t.vel.y = 0;
    }
    p.addScaledVector(t.vel, dt);
    // walls, posts, kerbs higher than the body
    _tSeg.start.set(p.x, p.y - 0.05, p.z); _tSeg.end.set(p.x, p.y + 0.3, p.z);
    this.collision.resolveCapsule(_tSeg, R, _tCorr);
    _tCorr.y = 0;
    if (_tCorr.lengthSq() > 1e-8) {
      p.add(_tCorr);
      const nx = _tCorr.x, nz = _tCorr.z, l = Math.hypot(nx, nz);
      const vn = (t.vel.x * nx + t.vel.z * nz) / l;
      if (vn < 0) { t.vel.x -= (nx / l) * vn * 1.3; t.vel.z -= (nz / l) * vn * 1.3; t.vel.x *= 0.6; t.vel.z *= 0.6; }
    }
    // cars: bounce off their sides, land on their roofs
    let roof = -Infinity;
    for (const k of this.carBodiesNear(p, 7)) {
      const dx = p.x - k.x, dz = p.z - k.z, sh = Math.sin(k.h), chh = Math.cos(k.h);
      const lx = dx * chh - dz * sh, lz = -(dx * sh + dz * chh);
      const ox = k.hx + R - Math.abs(lx), oz = k.hz + R - Math.abs(lz);
      if (ox <= 0 || oz <= 0) continue;
      const top = k.top ?? k.y + 1.5;
      if (p.y - LIE >= top - 0.35) { roof = Math.max(roof, top); continue; }
      if (p.y > top + 0.5) continue;
      // out through the nearer side
      let nx: number, nz: number, d: number;
      if (ox < oz) { const sg = Math.sign(lx) || 1; nx = chh * sg; nz = -sh * sg; d = ox; }
      else { const sg = Math.sign(lz) || 1; nx = -sh * sg; nz = -chh * sg; d = oz; }
      p.x += nx * d; p.z += nz * d;
      const vn = t.vel.x * nx + t.vel.z * nz;
      if (vn < 0) { t.vel.x -= nx * vn * 1.3; t.vel.z -= nz * vn * 1.3; t.vel.x *= 0.55; t.vel.z *= 0.55; k.hit?.(); }
    }
    const g0 = this.collision.groundHeight(_tProbe.set(p.x, p.y + 0.8, p.z), 4);
    const ground = Math.max(g0 ?? -Infinity, roof);
    t.roof = roof > -Infinity && roof >= (g0 ?? -Infinity);
    if (ground === -Infinity) return;
    if (t.phase === 'air') {
      t.tilt += t.spin * dt;
      if (p.y - LIE <= ground + 0.1 && t.vel.y < 0) {
        const hard = -t.vel.y;
        p.y = ground + LIE; t.vel.y = 0; t.phase = 'slide';
        t.tilt = Math.atan2(Math.sin(t.tilt), Math.cos(t.tilt));
        t.lie = t.tilt >= 0 ? Math.PI / 2 : -Math.PI / 2;
        if (t.ch === this.active) this.rig.shake(Math.min(0.8, 0.2 + hard * 0.06));
        this.sfx.thud(Math.min(1, hard / 8));
      }
      if (t.t > 5) { p.y = ground + LIE; t.phase = 'slide'; }
    } else {
      // sliding: follow the ground down a kerb; off a roof edge (or a ledge) it flies again
      if (p.y - LIE > ground + 0.35) { t.phase = 'air'; t.spin = 3; return; }
      p.y = ground + LIE;
      t.tilt += (t.lie - t.tilt) * Math.min(1, dt * 10);
      if (Math.hypot(t.vel.x, t.vel.z) < 0.3 && !t.roof) { t.phase = 'lying'; t.t = 0; t.vel.set(0, 0, 0); }
    }
  }

  /** The thrown character's body about its hips: tumbling in the air, face down while sliding and lying, back on its feet. */
  private poseThrown(c: Character): void {
    const t = this.thrown!;
    c.velocity.set(t.phase === 'air' ? t.vel.x : 0, 0, t.phase === 'air' ? t.vel.z : 0);
    c.grounded = t.phase !== 'air';
    c.model.position.y = 0;
    if (t.phase === 'up') {
      const k = Math.min(1, t.t / 0.8), s = k * k * (3 - 2 * k);
      c.root.rotation.set(t.lie * (1 - s), t.yaw, 0, 'YXZ');
      c.root.position.copy(t.feet);
      return;
    }
    c.root.rotation.set(t.tilt, t.yaw, 0, 'YXZ');
    c.root.updateMatrix();
    // root = hips - R * (0, hipH, 0)
    _tProbe.set(0, t.hipH, 0).applyQuaternion(c.root.quaternion);
    c.root.position.copy(t.pos).sub(_tProbe);
  }

  /** Where the camera should follow a thrown character: the body's centre, or the hips while getting up. */
  private thrownCentre(): THREE.Vector3 {
    const t = this.thrown!;
    if (t.phase !== 'up') return t.pos;
    const k = Math.min(1, t.t / 0.8);
    return _tProbe.copy(t.feet).setY(t.feet.y + t.hipH * k + 0.14 * (1 - k));
  }

  /** The bike's head lamp at night: a real spot (the car headlight slot). */
  private bikeLamp(on: boolean): void {
    if (!on || this.env.night < 0.05) return;
    const o = this.ebike.obj;
    o.updateMatrixWorld();
    const p = this.ebike.local(this.ebike.spec.headlamp).applyMatrix4(o.matrixWorld);
    const t = new THREE.Vector3(0, -1.2, -20).applyMatrix4(o.matrixWorld).sub(p);
    this.lampLights.spot(14, p, t, new THREE.Color('#fff4e0'), 520 * this.env.night, 45, 0.42, 0.6, 1.4);
  }

  /** Cars near a point as oriented boxes with their velocity (for the bike). */
  private carBodiesNear(p: THREE.Vector3, r: number): CarBody2D[] {
    const out: CarBody2D[] = [];
    const now = performance.now() / 1000;
    for (const c of this.traffic.near(p, r)) {
      if (Math.abs(c.obj.position.y - p.y) > 2) continue;
      out.push({ x: c.obj.position.x, z: c.obj.position.z, y: c.obj.position.y, top: c.obj.position.y + (c.half.y > 3.5 ? 3.0 : 1.5), hx: c.half.x, hz: c.half.y, h: c.obj.rotation.y, speed: c.speed, fwdX: c.fwd.x, fwdZ: c.fwd.z,
        hit: () => { c.hitAt = now; c.crashT = Math.max(c.crashT, 2); } });
    }
    for (const d of [...this.parked, ...this.police.cars]) {
      if (d.obj.position.distanceToSquared(p) > r * r || Math.abs(d.obj.position.y - p.y) > 2) continue;
      const fw = d.forward;
      out.push({ x: d.obj.position.x, z: d.obj.position.z, y: d.obj.position.y, top: d.obj.position.y + (d.half.y > 3.5 ? 3.0 : 1.5), hx: d.half.x, hz: d.half.y, h: d.heading, speed: d.speed, fwdX: fw.x, fwdZ: fw.z });
    }
    return out;
  }

  /** A drivable car at the kerb of the nearest non-arterial lane, parallel to it. */
  private parkNear(p: THREE.Vector3, model: number): void {
    let best: { pos: THREE.Vector3; tan: THREE.Vector3; w: number } | null = null, bd = 60;
    const pos = new THREE.Vector3(), tan = new THREE.Vector3();
    for (const lane of this.traffic.roads.lanesNear(p)) {
      if (lane.index !== lane.count - 1 || lane.path.length < 20 || lane.from.z > 0.5 || lane.to.z > 0.5) continue;
      for (let s = 6; s < lane.path.length - 6; s += 4) {
        lane.path.at(s, pos, tan);
        const d = pos.distanceTo(p);
        if (d < bd) { bd = d; best = { pos: pos.clone(), tan: tan.clone(), w: lane.width }; }
      }
    }
    if (!best) return;
    const { obj, half } = this.traffic.spawn(model);
    const right = new THREE.Vector3(-best.tan.z, 0, best.tan.x);
    // parked Guangzhou-style, up on the pavement just past the kerb, clear of the traffic lane
    obj.position.copy(best.pos).addScaledVector(right, best.w / 2 + half.x + 0.15);
    const g = this.collision.groundHeight(obj.position.clone().setY(obj.position.y + 2), 4);
    if (g !== null) obj.position.y = g;
    obj.rotation.y = Math.atan2(-best.tan.x, -best.tan.z);
    this.scene.add(obj);
    this.parked.push(new DriveCar(obj, half, true));
  }

  private begin(): void {
    el('#help').hidden = true;
    this.hud.show(true);
    this.playing = true;
    this.input.requestLock();
    this.sfx.unlock();
    this.radio.unlock();
    this.hud.toast(`${this.characters[this.active].spec.name} · ${this.characters[this.active].spec.home}`);
    if (this.bikeHintT === 0) this.bikeHintT = 2.6;
  }

  /** The music: N / B / P / - / = anywhere (M opens the player, see init); plays while riding or driving. */
  private updateRadio(dt: number, vehicle: boolean): void {
    const r = this.radio;
    if (this.input.takeKey('KeyN')) r.next(1);
    if (this.input.takeKey('KeyB')) r.prev();
    if (this.input.takeKey('KeyP')) r.toggle();
    if (this.input.takeKey('Minus') || this.input.takeKey('NumpadSubtract')) r.nudgeVolume(-0.1);
    if (this.input.takeKey('Equal') || this.input.takeKey('NumpadAdd')) r.nudgeVolume(0.1);
    const talking = this.voice.talking || (this.dialogue?.open ?? false);
    this.radioVehicle = vehicle;
    r.update(dt, { vehicle, duck: talking, hold: !el('#help').hidden || (r.pauseWhenHidden && document.hidden) });
    this.radioUI?.update(dt, vehicle);
    if (vehicle && !this.radioHint && this.playing) {
      this.radioHint = true;
      try { localStorage.setItem('gz.radio.hint', '1'); } catch { /* private window */ }
      this.hud.toast(r.tracks.length ? '车载音乐 · M 打开播放器 · N 下一首 · P 暂停 · − / = 音量' : '车载音乐 · 按 M 打开播放器（还没放歌，面板里有添加方法）', '', 4.5);
    }
  }

  /** seconds until the one-time "your e-bike is right here" hint (0 = not scheduled, -1 = shown) */
  private bikeHintT = 0;
  private bikeHint(dt: number): void {
    if (this.bikeHintT <= 0) return;
    this.bikeHintT -= dt;
    if (this.bikeHintT > 0) return;
    this.bikeHintT = -1;
    if (this.characters[this.active].spec.key === 'ajie' && !this.rider) this.hud.toast('阿杰的电鸡就停在旁边（小地图上的绿色标记）· 走过去按 F 骑上', '', 4.5);
  }

  private setActive(index: number, animate = true): void {
    const prev = this.characters[this.active];
    if (prev && index !== this.active) { prev.velocity.set(0, 0, 0); prev.sprinting = false; }
    this.active = index;
    const c = this.characters[index];
    this.hud.setCharacter(c.spec, index);
    const seated = this.seat.get(index);
    if (animate) {
      this.rig.beginSwitch(seated ? seated.heading + Math.PI : c.heading);
      this.hud.toast(`切换到 ${c.spec.name}`);
    } else this.rig.snap(c.root.position, c.heading);
  }

  update(dt: number, elapsed: number): void {
    this.frame += 1;
    resizeRenderer(this.renderer, this.camera);
    if (!this.ready) return;
    this.fpsAccum += dt; this.fpsFrames += 1;
    if (this.fpsAccum > 0.5) { this.fps = this.fpsFrames / this.fpsAccum; this.fpsAccum = 0; this.fpsFrames = 0; }
    if (this.paused) { this.radio.update(0, { vehicle: false, duck: false, hold: true }); this.publish(); return; }
    this.elapsed += dt;
    GZ.uTime.value = this.elapsed;
    const player = this.characters[this.active];
    // --- clock: [ / ] step an hour, time runs CLOCK_RATE game minutes per second
    if (this.input.held('BracketRight')) this.env.setHour(this.env.hour + dt * 3);
    else if (this.input.held('BracketLeft')) this.env.setHour(this.env.hour - dt * 3);
    else if (this.playing) this.env.setHour(this.env.hour + (dt * CLOCK_RATE) / 60);
    if (this.input.takeHelp()) {
      const help = el('#help');
      help.hidden = !help.hidden;
      if (help.hidden) this.begin();
    }
    const sw = this.input.takeSwitch();
    if (this.playing && sw !== null && !this.rig.switching && !this.dialogue?.open && !this.photo?.active) {
      const next = sw === 'next' ? (this.active + 1) % this.characters.length : sw;
      if (next !== this.active) this.setActive(next);
    }
    this.input.takeLook(this.lookVec);
    const zoomSteps = this.input.takeZoom();
    if (this.playing && !this.photo.active) this.rig.addLook(this.lookVec.x, this.lookVec.y);
    if (!this.photo.active) this.rig.zoom(zoomSteps);
    const talking = (this.dialogue.open && this.dialogue.blocking) || this.photo.active;
    const controllable = this.playing && !this.rig.switching && !this.hud.bustedShowing && !this.metroMenu?.open && !this.ride && !talking;
    this.input.readMove(this.moveVec);
    if (!controllable) this.moveVec.set(0, 0);
    const active = this.characters[this.active];
    let car = this.seat.get(this.active) ?? null;
    const jumpRaw = this.input.takeJump();
    const jumpPressed = jumpRaw && controllable;
    this.apmTrains.update(dt);
    this.boardCool = Math.max(0, this.boardCool - dt);
    const onBike = this.rider?.ch === this.active ? this.rider : null;
    const thrownMe = this.thrown?.ch === this.active;
    const gate = !car && !onBike && !thrownMe && this.playing && !this.riding ? this.metro.at(active.root.position) : null;
    const nearBike = !car && !onBike && !thrownMe && !this.riding && this.playing && !this.rider && this.bikeReach(active.root.position);
    // E talks (orders, people, the metro gates); F works vehicles. A conversation takes E / Space / 1-4 first.
    const talk = this.input.takeTalk();
    const veh = this.input.takeInteract();
    const digit = this.input.takeDigit();
    const wasTalking = this.dialogue.open;
    if (wasTalking) this.dialogue.update(dt, talk || jumpRaw, digit);
    if (this.photo.active) { this.input.readMove(this.photoMove); this.photo.update(dt, this.lookVec, (jumpRaw || talk) && !wasTalking, this.input.takeKey('Escape'), zoomSteps, this.photoMove); }
    // choices want the cursor: let go of the pointer lock while answering, take it back after
    if (this.dialogue.choosing && this.input.pointerLocked) { document.exitPointerLock(); this.relock = true; }
    else if (this.relock && !this.dialogue.choosing) { this.relock = false; this.input.requestLock(); }
    const onFoot = !car && !onBike && !thrownMe && !this.riding;
    const ord = this.orders.update(dt, active.root.position, onFoot, talk && !wasTalking && !talking && controllable, this.playing && !this.ride);
    this.orderPrompt = ord.prompt;
    if ((veh || (talk && !wasTalking && !ord.used && !this.photo.active)) && controllable && !thrownMe) {
      if (this.riding) this.alight(active, false);
      else if (onBike) this.getOffBike();
      else if (car) this.exitCar(active, car);
      else if (gate) this.openMetro(gate);
      else if (nearBike) this.getOnBike();
      else this.enterNearest(active);
      car = this.seat.get(this.active) ?? null;
    }
    if (car) {
      // Ah Jie drives like a courier on the clock; Uncle Keung like a man who owns three buildings
      this.driving.maxSpeed = active.spec.key === 'ajie' ? 35 : active.spec.key === 'qiang' ? 30 : 32;
      this.driving.grip = active.spec.key === 'ajie' ? 1.12 : 1.0;
      this.driving.update(car, this.pilot ? this.pilot(car, dt) : { throttle: this.moveVec.y, steer: this.moveVec.x, handbrake: this.input.handbrake }, dt);
      if (car.rescued) this.hud.toast('掉进珠江了……捞回岸上', 'bad', 2);
      else if (car.atEdge && !this.hud.isToasting()) this.hud.toast('前方无路 · 已到地图边界', '', 1.2);
      if (car.landing > 3) { this.rig.shake(Math.min(1, (car.landing - 3) / 9)); }
      if (car.landing > 5) this.foodJolt((car.landing - 5) * 0.03);
      car.landing = 0;
      const impact = car.impact;
      if (car.impact > 4 && car.impact > impact + 2) this.facts.crash = { pos: car.obj.position.clone(), at: performance.now() / 1000, victim: 'wall' };
      const knocked = this.pedestrians.hitByCar(car);
      if (knocked.length) {
        this.facts.crash = { pos: knocked[0].pos, at: performance.now() / 1000, victim: 'person' };
        this.crime('hit_person', knocked[0].pos);
        car.speed *= Math.pow(0.88, knocked.length);
        if (!this.hud.isToasting()) this.hud.toast(knocked.length > 1 ? `撞倒了 ${knocked.length} 个路人` : '撞倒了一个路人', 'bad', 1.6);
      }
      active.root.position.copy(car.obj.position);
      active.velocity.set(0, 0, 0);
    } else if (this.riding) {
      this.rideApm(active, dt);
    } else if (onBike || thrownMe) {
      // the bike and the thrown rider are stepped below
    } else {
      this.intent.move.copy(this.moveVec);
      this.intent.sprint = this.input.sprintHeld();
      this.intent.walk = this.input.walking();
      this.intent.jump = jumpPressed;
      this.controller.update(active, this.intent, this.rig.yaw, dt);
      if (this.traffic.pushOut(active.root.position, 0.35)) { active.velocity.x *= 0.5; active.velocity.z *= 0.5; }
      for (const pc of this.parked) this.pushFromCar(active.root.position, pc);
      if (!this.rider) this.pushFromBike(active.root.position);
      if (this.pedestrians.pushPlayer(active.root.position, 0.3)) { active.velocity.x *= 0.7; active.velocity.z *= 0.7; }
      if (this.apmPax.pushPlayer(active.root.position, 0.3)) { active.velocity.x *= 0.7; active.velocity.z *= 0.7; }
      if (this.plaza?.pushPlayer(active.root.position, 0.3)) { active.velocity.x *= 0.7; active.velocity.z *= 0.7; }
      // the APM gates: tap in when crossing into the paid side, a beep out again
      const paid = this.apm.paidAt(active.root.position);
      if (paid && !this.apmPaid) {
        if (this.metroCard < 2 && this.jobs.cash >= 50) { this.jobs.cash -= 50; this.metroCard += 50; }
        this.metroCard = Math.max(0, this.metroCard - 2);
        this.hud.toast(`嘀 · 羊城通 −¥2（余 ¥${this.metroCard}）· ${paid.name}站`, '', 1.8);
      } else if (!paid && this.apmPaid && !this.riding) this.hud.toast('嘀 · 出站', '', 1.2);
      if (!this.riding) this.apmPaid = paid ? paid.key : null;
      // stepping through an open screen door onto an APM train
      if (this.boardCool <= 0 && this.playing) {
        const b = this.apmTrains.boardable(active.root.position);
        if (b) this.board(active, b.train, b.car, b.local);
      }
    }
    this.updateBike(dt, controllable);
    this.bikeHint(dt);
    this.updateRadio(dt, this.playing && (car !== null || (onBike !== null && onBike.mount > 0.5) || thrownMe));
    // cars left mid-air or rolling keep simulating until they come to rest
    for (const pc of this.parked) {
      if (pc.settled || pc === car || [...this.seat.values()].includes(pc)) continue;
      this.driving.update(pc, IDLE_DRIVE, dt);
      pc.landing = 0;
      if (!pc.airborne && !pc.inWater && Math.abs(pc.vy) < 0.05 && Math.abs(pc.speed) < 0.05) pc.settled = true;
    }
    if (!car && !onBike && !thrownMe) this.waterCheck(active, dt);
    const f = this.facts;
    f.pos.copy(active.root.position);
    if (dt > 0) {
      this.rawVel.copy(f.pos).sub(this.prevPlayer).divideScalar(dt);
      if (this.rawVel.lengthSq() > 60 * 60) this.rawVel.set(0, 0, 0);
      f.vel.lerp(this.rawVel, Math.min(1, dt * 8));
    }
    this.prevPlayer.copy(f.pos);
    f.driving = car !== null || !!onBike;
    f.onSidewalk = (car ? car.obj.position.y : f.pos.y) > 0.08;            // carriageways ~0.02 m, pavements at the kerb (0.15 m)
    f.sprinting = !car && active.sprinting;
    const brain = this.playing ? this.brain : null;
    const obstacles: Obstacle[] = [{ pos: active.root.position, kind: 'player' }];
    for (const pc of this.parked) if (pc !== car) obstacles.push({ pos: pc.obj.position, kind: 'parked' });
    if (!this.rider) obstacles.push({ pos: this.ebike.obj.position, kind: 'parked' });
    for (const p of this.pedestrians.onRoad()) obstacles.push({ pos: p, kind: 'ped', moving: true });
    for (const pc of this.police.cars) obstacles.push({ pos: pc.obj.position, kind: 'parked', moving: true });
    this.pools.begin();
    this.traffic.pools = this.pools;
    this.traffic.update(dt, obstacles, f, brain);
    for (const pc of this.police.cars) this.pools.add(pc.obj, pc.half);
    if (car) this.pools.add(car.obj, car.half);
    this.pools.end(this.env.night);
    this.headlights.update(car ? car.obj : null, car ? car.half.y : 2.3, this.env.night);
    this.huachengSigns?.update(this.env.night);
    this.bikeLamp(!!onBike && onBike.mount > 0.5);
    if (this.playing) this.police.update(dt, active.root.position, car, (v) => this.sfx.setSiren(v), onBike ? this.bike.speed : null);
    this.resolveCarContacts(car, active.root.position);
    this.hud.setWanted(this.police.level, this.police.level > 0 && this.police.nearestDistance(active.root.position) < 70);
    this.signals.update(dt, this.camera.position);
    this.pedestrians.focus = active.root.position;
    this.fillBlockers(car, onBike ? this.bike.obj.position : null);
    this.pedestrians.update(dt, this.camera.position, f, brain);
    if (brain) brain.tick(() => [...this.pedestrians.observe(f, 8), ...this.traffic.observe(f, 6)]);
    if (this.input.takeBrainToggle()) {
      this.overlay.toggle();
      this.hud.toast(this.overlay.visible ? 'NPC 决策标签：开（J）' : 'NPC 决策标签：关（J）', '', 1.4);
    }
    const idle: MoveIntent = { move: new THREE.Vector2(), sprint: false, walk: false, jump: false };
    for (const [i, c] of this.characters.entries()) {
      const seated = this.seat.get(i);
      if (seated) { c.root.position.copy(seated.obj.position); continue; }
      c.idleWindow = this.rider?.ch === i ? 4.4 : null;
      if (this.rider?.ch === i) {
        const r = this.rider, b = this.bike;
        c.velocity.set(0, 0, 0); c.grounded = true;
        c.animate(dt);
        r.pose.apply(this.ebike, r.mount, r.foot, i === this.active ? this.moveVec.y : 0, b.lean, b.steer, b.obj.position.y);
        continue;
      }
      if (this.thrown?.ch === i) { c.animate(dt); this.poseThrown(c); continue; }
      if (c !== active) this.controller.update(c, idle, 0, dt);
      c.animate(dt);
    }
    this.nearCar = !car && this.playing && (this.nearestParked(active.root.position, 3.2) !== null || this.traffic.nearestDistance(active.root.position) < 2.4);
    if (this.playing) {
      const ev = this.jobs.update(dt, elapsed, active.root.position);
      if (ev?.type === 'late') this.hud.notify({ from: '小准', text: '您已超时。超时订单配送费 −30%，服务分 −0.03。请继续配送，顾客仍在等待。', tone: 'bad' });
      if (ev?.type === 'failed') { this.jobToast(ev); this.orders.cancel(); }
    }
    active.root.visible = !this.photo.active;      // the phone's view is from the eyes
    if (this.photo.active) { /* PhotoMode holds the camera */ }
    else if (car) this.rig.updateDriving(car.obj.position, car.heading, dt, Math.abs(car.speed));
    else if (onBike && onBike.mount > 0.5) this.rig.updateRiding(this.bike.obj.position, this.bike.heading, dt, Math.abs(this.bike.speed));
    else if (thrownMe && this.thrown) this.rig.updateThrown(this.thrownCentre(), dt);
    else this.rig.update(player.root.position, dt, this.riding ? 0 : Math.hypot(player.velocity.x, player.velocity.z));
    this.env.follow(active.root.position, car ? 260 : 160);
    // under the street (entrance stairs and halls, APM stations, passages, tunnels): indoor light
    const cam = this.camera.position;
    const { inApm, underK } = this.underground(cam);
    const surface = this.city.root.visible;
    this.apmPax.update(dt, this.camera, this.riding ? null : active.root.position, this.env.hour, this.apm.group.visible);
    // 花城广场's people: while the camera is on the surface within a few hundred metres of the square
    const bxc = cam.x, byc = -cam.z;
    this.plaza?.update(dt, this.camera, this.facts, this.env.hour, inApm < 1 && bxc > -260 && bxc < 260 && byc > -720 && byc < 480);
    this.apmAudio(inApm >= 1 || !!this.riding);
    this.mallSigns?.update(dt);
    if (this.fountain) {
      this.fountain.update(dt, this.env.hour, this.env.night, cam);
      if (!surface) this.fountain.group.visible = false;
      const d = cam.distanceTo(this.fountain.centre);
      this.sfx.setFountain(surface ? THREE.MathUtils.clamp(1 - (d - 25) / 140, 0, 1) : 0, this.fountain.power);
    }

    this.env.shadows(dt);
    this.nightLights.update(dt, this.camera, this.env.night);
    this.tunnelLights.update(dt, this.camera, underK);        // below ground the lamp slots are the tunnel's (or off)
    this.nearFuture.update(this.env.night);
    this.facades.update(dt, this.camera.position);
    this.drones.update(dt, this.env.hour, this.env.night);
    if (!surface) this.drones.points.visible = false;
    if (this.input.takeWeather()) {
      this.weather.set(this.weather.target > 0.1 ? 0 : 1);
      this.hud.toast(this.weather.target > 0 ? '下雨了（R 切换天气）' : '雨停了（R 切换天气）', '', 1.6);
    }
    this.weather.update(dt, this.camera, active.root.position.y, this.env.hour, this.env.night);
    if (underK >= 0.5) this.weather.group.visible = false;          // no rain in the stations
    this.env.overcast = this.weather.rain;
    this.cullT -= dt;
    if (this.cullT <= 0) {
      this.cullT = 0.25;
      cullChunks(this.city.chunks, this.camera.position);
      this.pipeline.setHoles(this.metro.nearest(this.camera.position, 4), this.metro.undergroundBox());
    }
    this.overlay.update(this.camera, this.canvas.clientWidth, this.canvas.clientHeight);
    this.hud.update(dt, this.jobs, active.root.position, this.rig.yaw, active.stamina, active.exhausted);
    this.actors.update(dt, this.camera, innerWidth, innerHeight);
    this.carryBag(active, onFoot && this.jobs.phase === 'carrying' && !this.photo.active && !this.orders.summary.story?.includes('差评'));
    this.delivery.update(this.env.night);
    const rt = this.riding?.train;
    const ridePrompt = rt ? (rt.phase === 'dwell' && rt.doors > 0.85 ? '<kbd>F</kbd> 下车' : rt.next ? `开往 ${rt.next.name}` : null) : null;
    const bikePrompt = onBike ? '<kbd>F</kbd> 下车 · <kbd>Q</kbd> 喇叭 · <kbd>空格</kbd> 后刹甩尾' : nearBike ? (this.bike.crashed ? '<kbd>F</kbd> 扶起电鸡' : '<kbd>F</kbd> 骑上电鸡') : null;
    const orderPrompt = this.dialogue.open || this.photo.active ? null : this.orderPrompt;
    this.hud.setDriving(car ? car.speed : onBike ? this.bike.speed : null, orderPrompt ?? ridePrompt ?? bikePrompt ?? (gate ? (gate.kind === 'pavilion' ? '<kbd>E</kbd> 刷卡乘地铁' : '<kbd>E</kbd> 进站乘地铁') : this.nearCar ? '<kbd>F</kbd> 上车' : null));
    const sum = this.orders.summary;
    this.hud.setOrder(sum.state === 'none' ? '' : `${sum.story ?? ''}${sum.title}`, sum.note);
    this.updateRide(dt);
    this.minimap.draw(active.root.position, this.rig.yaw, [
      ...this.characters.filter((c) => c !== active).map((c) => ({ pos: c.root.position, color: c.spec.color, kind: 'friend' as const })),
      { pos: this.jobs.target.pos, color: this.jobs.phase === 'offer' ? '#f5ba49' : '#4fe0b0', kind: 'target' as const },
      ...this.police.cars.map((p) => ({ pos: p.obj.position, color: '#ff4d6d', kind: 'car' as const })),
      // where the e-bike was left (not while someone rides it)
      ...(this.rider ? [] : [{ pos: this.ebike.obj.position, color: '#c6f03c', kind: 'bike' as const }]),
    ]);
    const hh = Math.floor(this.env.hour), mm = Math.floor((this.env.hour - hh) * 60);
    el('#clock').textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    if (this.input.held('F3') && this.perfT <= 0) { this.perfOn = !this.perfOn; el('#perf').hidden = !this.perfOn; this.perfT = 0.4; }
    this.perfT -= dt;
    this.publish();
  }

  private readonly trainPrev = new Map<number, { phase: string; t: number; near: boolean }>();
  /**
   * APM sounds around the listener (the camera): doors opening / the closing warning within 40 m, the running
   * noise of the train ridden or the nearest one moving, and the platform announcement as a train runs in.
   */
  private apmAudio(under: boolean): void {
    const cam = this.camera.position;
    let level = 0, speed = 0;
    for (const t of this.apmTrains.trains) {
      const m0 = t.cars[0].elements, m1 = t.cars[1].elements;
      const cx = (m0[12] + m1[12]) / 2, cy = (m0[13] + m1[13]) / 2, cz = (m0[14] + m1[14]) / 2;
      const d = Math.hypot(cx - cam.x, cz - cam.z, (cy - cam.y) * 2);
      const mine = this.riding?.train === t;
      const vol = mine ? 1 : under ? Math.max(0, 1 - d / 40) : 0;
      const prev = this.trainPrev.get(t.id) ?? { phase: t.phase, t: t.t, near: false };
      if (t.phase === 'dwell' && prev.phase === 'dwell') {
        if (prev.t < 1 && t.t >= 1) this.sfx.doorAir(vol * 0.8);
        const c = closesAt(t);
        if (prev.t < c && t.t >= c) { this.sfx.doorBeep(vol, 2.8); this.sfx.doorAir(vol * 0.7, 3); }
      }
      // on the platform: the arrival announcement once per train, ~12 s out
      const target = t.target;
      const plat = !this.riding && under && Math.abs(cam.y - this.apm.L.platform - 1.6) < 2.5;
      const coming = plat && t.phase === 'run' && !!target && d < 170 && d > 60 && this.apmPax.focusKey === target.st.key;
      if (coming && !prev.near) {
        this.sfx.announce('列车即将进站，请站在黄线以内排队候车，先下后上。');
      }
      this.trainPrev.set(t.id, { phase: t.phase, t: t.t, near: coming || (prev.near && t.phase === 'run') });
      if (t.phase === 'run') {
        const lv = mine ? 0.9 : under ? 0.8 * Math.max(0, 1 - d / 90) ** 2 : 0;
        if (lv > level) { level = lv; speed = t.v; }
      }
    }
    this.sfx.setTrain(level, speed);
  }

  /** Step through an open door onto an APM car: from now on the character rides in the car's frame. */
  private board(c: Character, train: Train, car: number, local: THREE.Vector3): void {
    this.riding = { train, car, local: local.clone() };
    this.rig.riding = true;
    this.rig.occluder = (o, d) => this.apmTrains.insideHit(train, car, o, d);
    c.velocity.set(0, 0, 0);
    this.rideApm(c, 0);
    this.hud.toast(train.next && train.next !== train.at ? `上车 · 开往 ${this.lineEnd(train)}` : `上车 · 开往 ${this.lineEnd(train)}`, 'good', 2);
  }

  private lineEnd(t: Train): string {
    return t.track === 1 ? '妇儿中心（林和西方向）' : '广州塔';
  }

  /** Riding: stand where we boarded, carried by the car; at a terminus everyone is put off. */
  private rideApm(c: Character, dt: number): void {
    const r = this.riding!;
    const t = r.train;
    const p = this.apmTrains.carToWorld(t, r.car, r.local, new THREE.Vector3());
    const yaw = this.apmTrains.carYaw(t, r.car);
    c.placeAt(p, yaw + Math.PI);
    c.velocity.set(0, 0, 0);
    if (t.terminus && t.phase === 'dwell' && t.doors > 0.95 && t.t > 1 + 2.5 + 3) this.alight(c, true);
    void dt;
  }

  private alight(c: Character, forced: boolean): void {
    const r = this.riding;
    if (!r) return;
    const at = this.apmTrains.alightPoint(r.train, r.car, r.local);
    if (!at) { if (!forced) this.hud.toast('列车行驶中，到站再下车', 'bad', 1.4); return; }
    const heading = this.apmTrains.carYaw(r.train, r.car) + Math.PI / 2 * (r.train.track === 1 ? 1 : -1);
    c.placeAt(at, heading);
    this.riding = null;
    this.rig.riding = false;
    this.rig.occluder = this.defaultOccluder;
    this.rig.snap(at, heading);
    this.boardCool = 2.5;
    if (forced) this.hud.toast('终点站 · 已下车', '', 2);
  }

  /** The ride picker at the gates: every station on the map, nearest first, with fare and ride time. */
  private openMetro(from: MetroExit): void {
    if (!this.metroMenu) return;
    const all = this.metro.stations().map((s) => {
      const d = Math.hypot(s.exit.x - from.x, s.exit.y - from.y);
      return { station: s.station, en: s.en, lines: s.lines, exit: s.exit, d, here: s.station === from.station,
        fare: d < 4000 ? 2 : d < 8000 ? 3 : 4, minutes: Math.round(3 + d / 420) };
    }).sort((a, b) => (a.here ? -1 : b.here ? 1 : a.d - b.d));
    this.metroMenu.show(from.station, all, (i) => {
      if (i === null) return;
      this.startRide(all[i].exit, all[i].fare, all[i].minutes);
    }, this.metroCard);
  }

  private startRide(to: MetroExit, fare: number, minutes: number): boolean {
    if (this.metroCard < fare) {
      if (this.jobs.cash < 50) { this.hud.toast(`羊城通只剩 ¥${this.metroCard}，现金也不够充值……`, 'bad', 2.4); return false; }
      this.jobs.cash -= 50;
      this.metroCard += 50;
    }
    this.ride = { t: 0, to, fare, minutes, moved: false };
    return true;
  }

  /** Fade to black, come up in the destination's hall facing the stair, fade back in. */
  private updateRide(dt: number): void {
    if (!this.ride) return;
    if (!this.fade) {
      this.fade = document.createElement('div');
      this.fade.style.cssText = 'position:fixed;inset:0;background:#000;opacity:0;pointer-events:none;z-index:25';
      document.body.appendChild(this.fade);
    }
    const r = this.ride;
    r.t += Math.min(dt, 0.05);
    this.fade.style.opacity = String(r.t < 0.5 ? r.t / 0.5 : r.t < 1.0 ? 1 : Math.max(0, 1 - (r.t - 1.0) / 0.6));
    if (!r.moved && r.t >= 0.55) {
      r.moved = true;
      const c = this.characters[this.active];
      const a = this.metro.arrive(r.to);
      c.placeAt(a.pos, a.heading);
      c.velocity.set(0, 0, 0);
      this.rig.snap(a.pos, a.heading);
      this.pedestrians.regather();
      this.env.setHour((this.env.hour + r.minutes / 60) % 24);
      this.metroCard -= r.fare;
      if (this.police.level > 0) { this.police.clear(); this.hud.toast(`钻进地铁，警察跟丢了 · 到达 ${r.to.station}站`, 'good', 3); }
      else this.hud.toast(`到达 ${r.to.station}站 · 羊城通 −¥${r.fare}（余 ¥${this.metroCard}）· ${r.minutes} 分钟`, 'good', 2.8);
    }
    if (r.t > 1.6) { this.ride = null; this.fade.style.opacity = '0'; }
  }

  /** Every car-to-car contact this frame: the player's car, patrol cars, nearby parked cars, and traffic. */
  private resolveCarContacts(car: DriveCar | null, player: THREE.Vector3): void {
    const dyn: DriveCar[] = [];
    if (car) dyn.push(car);
    for (const pc of this.police.cars) dyn.push(pc);
    for (const pc of this.parked) if (pc !== car && pc.obj.position.distanceToSquared(player) < 80 * 80) dyn.push(pc);
    const hits = this.carHits.resolve(dyn, (p, r) => this.traffic.near(p, r));
    for (const h of hits) {
      if (h.a !== car && h.b !== car) continue;
      const now = performance.now() / 1000;
      if (h.rel > 3) this.facts.crash = { pos: h.pos.clone(), at: now, victim: 'car' };
      if (h.rel > 4) this.foodJolt((h.rel - 4) * 0.025);
      if (h.rel > 5.5) this.crime('crash_car', h.pos);
      if (h.rel > 4) this.rig.shake(Math.min(0.8, h.rel / 20));
    }
  }

  /**
   * 花城汇's sunken court, its escalator wells and B1 (the corridor, the link, the vestibule, the north escalators): dry
   * ground below the street, not the river (the water check would have fished anyone out of the court in a second).
   */
  private huachengDry(p: THREE.Vector3): boolean {
    const hc = this.huacheng as unknown as { court: { rect: number[]; z: number }; wells?: number[][] } | null;
    if (!hc) return false;
    const bx = p.x, by = -p.z;
    const inR = (r: number[], pad = 0.5) => bx > r[0] - pad && bx < r[2] + pad && by > r[1] - pad && by < r[3] + pad;
    if (p.y < hc.court.z - 2) return false;
    if (inR(hc.court.rect) || (hc.wells ?? []).some((w) => inR(w))) return true;
    const nh = (this.huacheng as unknown as { north_half?: { rect: number[] } | null }).north_half;
    if (nh && inR(nh.rect)) return true;                    // the north court (gz_north)
    const m = this.mall;
    return !!m && [m.rect, m.link, m.vest, m.xlink, m.well].some((r) => inR(r));
  }

  /** Walked into the Pearl River (or a pond): after a second, back to the last dry spot. Cars handle this in Driving. */
  private waterCheck(active: Character, dt: number): void {
    const p = active.root.position;
    if (p.y > -0.6 || this.metro.underground(p) || this.apm.under(p) > 0 || this.huachengDry(p)) {
      this.wetT = 0;
      if (this.frame % 30 === 0) this.safe.copy(p);
      return;
    }
    this.wetT += dt;
    if (this.wetT < 1.2) return;
    this.wetT = 0;
    active.placeAt(this.safe.clone().setY(this.safe.y + 0.3), active.heading);
    this.hud.toast('掉进珠江了……捞回岸上', 'bad', 2);
  }

  private nearestParked(p: THREE.Vector3, maxDist: number): DriveCar | null {
    let best: DriveCar | null = null, bd = maxDist;
    for (const c of this.parked) {
      if ([...this.seat.values()].includes(c)) continue;
      const d = Math.hypot(c.obj.position.x - p.x, c.obj.position.z - p.z) - c.half.x;
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  private crime(kind: CrimeKind, pos: THREE.Vector3): void {
    const now = performance.now() / 1000;
    if (kind === 'crash_car') { if (now - this.lastCarCrimeAt < 3) return; this.lastCarCrimeAt = now; }
    const c: Crime = { id: ++this.crimeSeq, kind, pos: pos.clone(), at: now };
    this.crimes.push(c);
    while (this.crimes.length && (this.crimes.length > 20 || now - this.crimes[0].at > 30)) this.crimes.shift();
    if (this.brain.status !== 'live') this.pedestrians.witnessByRule(c, this.rng);
  }

  private enterNearest(ch: Character): void {
    let car = this.nearestParked(ch.root.position, 3.2);
    if (!car) {
      const t = this.traffic.takeNearest(ch.root.position, 2.4);
      if (t) {
        this.scene.attach(t.obj);
        car = new DriveCar(t.obj, t.half, false);
        car.speed = 0;
        this.parked.push(car);
        this.hud.toast('抢了一辆车', 'bad', 1.6);
        this.crime('steal_car', ch.root.position);
      }
    }
    if (!car) return;
    this.seat.set(this.active, car);
    car.parked = false;
    ch.root.visible = false;
    this.rig.yaw = car.heading;
    if (!this.hud.isToasting()) this.hud.toast(`${ch.spec.name} 上车 · W/S 油门刹车 · 空格手刹 · F 下车`, '', 2.6);
  }

  private exitCar(ch: Character, car: DriveCar): void {
    const h = car.heading;
    const left = new THREE.Vector3(-Math.cos(h), 0, Math.sin(h));
    const out = car.obj.position.clone().addScaledVector(left, car.half.x + 0.7);
    const side = this.collision.raycastDistance(car.obj.position.clone().setY(car.obj.position.y + 1), left, car.half.x + 1.2);
    if (side < car.half.x + 1.0) out.copy(car.obj.position).addScaledVector(left, -(car.half.x + 0.7));
    car.speed = 0;
    car.parked = true;
    car.settled = false;
    this.seat.delete(this.active);
    ch.placeAt(out.setY(out.y + 0.3), h + Math.PI);
    ch.root.visible = true;
    this.rig.snap(ch.root.position, ch.heading);
  }

  /** Nearest point on a traffic lane centreline (three.js) and the lane's heading there, or null. */
  private nearestLanePoint(p: THREE.Vector3): { pos: THREE.Vector3; heading: number } | null {
    let best: { pos: THREE.Vector3; heading: number } | null = null, bd = 60 * 60;
    const q = new THREE.Vector3();
    for (const lane of this.traffic.roads.lanesNear(p)) {
      const pts = lane.path.pts;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz;
        if (L2 < 1e-6) continue;
        const t = THREE.MathUtils.clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / L2, 0, 1);
        q.lerpVectors(a, b, t);
        const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2 + ((q.y - p.y) * 3) ** 2;   // prefer the deck the car is on
        if (d < bd) { bd = d; best = { pos: q.clone(), heading: Math.atan2(-dx, -dz) }; }
      }
    }
    return best;
  }

  /** Walking into the parked e-bike: out of its footprint (yaw-only frame: it may be lying on its side). */
  private pushFromBike(p: THREE.Vector3): void {
    const o = this.ebike.obj.position, h = this.bike.heading;
    const dx = p.x - o.x, dz = p.z - o.z, dy = p.y - o.y;
    if (Math.abs(dx) > 2.5 || Math.abs(dz) > 2.5 || dy < -0.6 || dy > 1.3) return;
    const c = Math.cos(h), sn = Math.sin(h);
    let lx = dx * c - dz * sn, lz = dx * sn + dz * c;          // right, back
    const hx = (this.bike.crashed ? 0.6 : 0.3) + 0.3, hz = this.bike.half.y + 0.25;
    if (Math.abs(lx) >= hx || Math.abs(lz) >= hz) return;
    if (hx - Math.abs(lx) < hz - Math.abs(lz)) lx = Math.sign(lx || 1) * hx; else lz = Math.sign(lz || 1) * hz;
    p.x = o.x + lx * c + lz * sn;
    p.z = o.z - lx * sn + lz * c;
  }

  private pushFromCar(p: THREE.Vector3, car: DriveCar): void {
    const inv = car.obj.matrixWorld.clone().invert();
    car.obj.updateMatrixWorld();
    const l = p.clone().applyMatrix4(inv);
    const hx = car.half.x + 0.35, hz = car.half.y + 0.35;
    if (Math.abs(l.x) < hx && Math.abs(l.z) < hz && Math.abs(l.y) < 2) {
      if (hx - Math.abs(l.x) < hz - Math.abs(l.z)) l.x = Math.sign(l.x || 1) * hx; else l.z = Math.sign(l.z || 1) * hz;
      p.copy(l.applyMatrix4(car.obj.matrixWorld));
    }
  }

  render(): void {
    this.env.update(this.camera, this.elapsed);
    this.lampLights.toView(this.camera);
    this.pipeline.render(this.scene, this.camera);
    if (this.photo?.active) this.photo.afterRender(this.canvas);
  }

  private publish(): void {
    const info = this.renderer.info;
    const a = this.characters[this.active];
    if (this.perfOn && this.frame % 15 === 0) {
      const tr = this.traffic?.stats();
      el('#perf').textContent =
        `${Math.round(this.fps)} fps · ${this.canvas.width}×${this.canvas.height}\n` +
        `draw calls ${info.render.calls} · 三角 ${(info.render.triangles / 1e6).toFixed(2)} M\n` +
        `车 ${tr?.cars} 停 ${tr?.stopped} 卡死 ${tr?.stuck} 回收 ${tr?.recycled} · 路人 ${this.pedestrians?.count} · 地铁乘客 ${this.apmPax?.count ?? 0}\n` +
        `通缉 ${this.police?.level ?? 0} · Jev ${this.brain.status} · 夜 ${GZ.uNight.value.toFixed(2)}\n` +
        `GPU ${this.pipeline.gpuStats().median} ms (p90 ${this.pipeline.gpuStats().p90}) · 分辨率 ${Math.round(this.pipeline.scale * 100)}%`;
    }
    window.__THREE_GAME_DIAGNOSTICS__ = {
      frame: this.frame, elapsed: this.elapsed, score: this.jobs?.cash ?? 0, targetScore: 0, complete: false,
      player: {
        position: a ? { x: a.root.position.x, y: a.root.position.y, z: a.root.position.z } : { x: 0, y: 0, z: 0 },
        speed: a ? Math.hypot(a.velocity.x, a.velocity.z) : 0,
      },
      renderer: { calls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries, textures: info.memory.textures },
      canvas: { clientWidth: this.canvas.clientWidth, clientHeight: this.canvas.clientHeight, width: this.canvas.width, height: this.canvas.height, dpr: this.renderer.getPixelRatio() },
      extra: {
        ready: this.ready, playing: this.playing, active: a?.spec.key, grounded: a?.grounded, fps: Math.round(this.fps),
        phase: this.jobs?.phase, delivered: this.jobs?.delivered, timeLeft: this.jobs?.timeLeft,
        collisionTris: this.collision?.triangles, timings: this.timings, wanted: this.police?.level,
        brain: { status: this.brain.status, calls: this.brain.calls, lastMs: this.brain.lastMs, agents: this.brain.lastAgents, overlay: this.overlay?.visible },
        pedestrians: this.pedestrians?.count, cars: this.traffic?.count, hour: this.env.hour,
      },
    };
  }

  private installHooks(): void {
    if (import.meta.env.DEV) (window as unknown as { __GAME__: unknown }).__GAME__ = this;
    window.__THREE_GAME_TEST_HOOKS__ = {
      seed: (v: number) => { this.rng = createSeededRandom(v); this.jobs?.setRng(this.rng); },
      setState: (name: string) => {
        if (name !== 'active-play' && name !== 'menu') throw new Error(`Unknown test state: ${name}`);
        if (name === 'active-play' && !this.playing) this.begin();
        return { state: name };
      },
      setPausedForScreenshot: (p: boolean) => { this.paused = p; },
      setReducedMotion: (on: boolean) => { if (on) for (const c of this.characters) c.freeze(); },
      hideDebugUi: () => {},
    };
    (window as unknown as { __GZ__: unknown }).__GZ__ = {
      key: (code: string, down: boolean) => this.input.setKey(code, down),
      look: (dx: number, dy: number) => this.rig.addLook(dx, dy),
      /** Teleport the active character to Blender (x, y) (snapped to the nearest walkway). */
      teleport: (x: number, y: number, heading = 0) => {
        const at = this.snapToWalk(fromBlender(x, y, 0));
        const car = this.seat.get(this.active);
        if (car) { car.obj.position.copy(at); car.speed = 0; }
        else this.characters[this.active].placeAt(at.clone().setY(at.y + 0.3), heading);
        this.rig.snap(at, heading);
        this.pedestrians.regather();
        return at.toArray();
      },
      hour: (h?: number) => { if (h !== undefined) this.env.setHour(h); return this.env.hour; },
      /** Metro: exits and where the player stands; `metro(station)` rides there (as if picked at the gates). */
      metro: (station?: string) => {
        const p = this.characters[this.active].root.position;
        if (station) {
          const s = this.metro.stations().find((x) => x.station === station);
          if (!s) return { error: 'no station ' + station };
          this.startRide(s.exit, 2, 5);
        }
        return { exits: this.metro.exits.length, pavilions: this.metro.exits.filter((e) => e.kind === 'pavilion').length, at: this.metro.at(p)?.id ?? null,
          stations: this.metro.stations().map((s) => s.station), menuOpen: this.metroMenu?.open ?? false, riding: !!this.ride };
      },
      /** Blender (x, y, z) of an exit's local point (lx, ly, lz), e.g. for shotAt. */
      metroLocal: (id: string, lx: number, ly: number, lz = 0) => { const e = this.metro.exits.find((x) => x.id === id); return e ? this.metro.local(e, lx, ly, lz) : null; },
      setView: (yaw: number, pitch: number, dist?: number) => { this.rig.yaw = yaw; this.rig.pitch = pitch; if (dist) this.rig.distance = dist; },
      step: (frames = 1, dt = 1 / 60) => {
        for (let i = 0; i < frames; i++) { this.simTime += dt; this.update(dt, this.simTime); }
        this.render();
        return this.characters[this.active]?.root.position.toArray();
      },
      shot: async (name: string) => {
        const sc = this.pipeline.scale; this.pipeline.scale = 1; this.pipeline.dynamic = false;
        this.render();
        this.pipeline.scale = sc; this.pipeline.dynamic = true;
        const data = this.canvas.toDataURL('image/png');
        const r = await fetch(`/__shot?name=${encodeURIComponent(name)}`, { method: 'POST', body: data });
        return r.text();
      },
      /** Camera placed by hand (Blender x, y, z for eye and target); renders one frame and saves it. */
      shotAt: async (name: string, eye: number[], target: number[]) => {
        this.camera.position.copy(fromBlender(eye[0], eye[1], eye[2]));
        this.camera.lookAt(fromBlender(target[0], target[1], target[2]));
        this.camera.updateMatrixWorld();
        this.nightLights.update(0.5, this.camera, this.env.night);
        const { underK: under } = this.underground(this.camera.position);
        for (let i = 0; i < 4; i++) this.tunnelLights.update(0.5, this.camera, under);
        this.facades.sync(this.camera.position);
        this.apmPax.sync(this.camera);
        this.plaza?.sync(this.camera);
        cullChunks(this.city.chunks, this.camera.position);
        const sc = this.pipeline.scale; this.pipeline.scale = 1; this.pipeline.dynamic = false;
        this.render();
        this.pipeline.scale = sc; this.pipeline.dynamic = true;
        const r = await fetch(`/__shot?name=${encodeURIComponent(name)}`, { method: 'POST', body: this.canvas.toDataURL('image/png') });
        return r.text();
      },
      /** The standard comparison set: street (spawn), towers, aerial over the axis, river; at each hour. */
      tour: async (tag: string, hours = [15, 18.3, 21.5]) => {
        const G = (window as unknown as { __GZ__: Record<string, (...a: unknown[]) => unknown> }).__GZ__;
        const out: unknown[] = [];
        const home = this.characters[this.active].spec.spawn;
        for (const h of hours) {
          this.env.setHour(h);
          G.teleport(home.x, -home.z, Math.PI);
          G.setView(2.6, -0.12, 5); G.step(20);
          out.push(await G.shot(`${tag}_street_${h}`));
          G.setView(0.6, -0.05, 6); G.step(4);
          out.push(await G.shot(`${tag}_towers_${h}`));
          out.push(await G.shotAt(`${tag}_aerial_${h}`, [420, -900, 260], [0, 150, 60]));
          // river channel spans y ~ -720 .. -1130 here; Canton Tower stands on the axis at (-7, -1272)
          out.push(await G.shotAt(`${tag}_river_${h}`, [250, -1090, 6], [-20, -250, 140]));
          out.push(await G.shotAt(`${tag}_tower_${h}`, [120, -700, 6], [-7, -1272, 260]));
        }
        return out;
      },
      driving: () => { const c = this.seat.get(this.active); return c ? { speed: c.speed, heading: c.heading, pos: c.obj.position.toArray() } : null; },
      traffic: () => this.traffic?.stats(),
      gpu: () => this.pipeline.gpuStats(),
      /**
       * GPU benchmark at full resolution: render `frames` frames (logic paused), spaced so the timer queries
       * resolve, then a back-to-back run for the sustained time per frame. Works with the panel hidden.
       * -> { median, p90, n, throughput, calls, tris, size }
       */
      bench: async (frames = 60) => {
        const sc = this.pipeline.scale, dyn = this.pipeline.dynamic;
        this.pipeline.scale = 1; this.pipeline.dynamic = false;
        this.pipeline.resetGpu();
        for (let i = 0; i < frames; i++) { this.render(); await new Promise((r) => setTimeout(r, 12)); }
        const g = this.pipeline.gpuStats();
        // throughput: frames rendered back to back, then wait for the GPU (one pixel read back): the time per frame
        // the machine really sustains (GPU and CPU overlapped). The GPU timer above can read high on ANGLE / Metal.
        const gl = this.renderer.getContext(), px = new Uint8Array(4);
        const n = Math.max(8, Math.min(30, frames));
        this.render(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const t0 = performance.now();
        for (let i = 0; i < n; i++) this.render();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const throughput = +((performance.now() - t0) / n).toFixed(2);
        this.pipeline.scale = sc; this.pipeline.dynamic = dyn;
        const info = this.renderer.info.render;
        return { ...g, throughput, calls: info.calls, tris: +(info.triangles / 1e6).toFixed(2), size: `${this.canvas.width}x${this.canvas.height}` };
      },
      weather: (v?: number) => { if (v !== undefined) this.weather.set(v); return { rain: this.weather.rain, target: this.weather.target, wet: this.weather.wetness }; },
      post: (on: boolean) => { this.pipeline.enabled = on; },
      ssr: (on: boolean) => { this.pipeline.ssr = on ? 1 : 0; },
      /** Regression suite (src/qa/QA.ts): run(prefix?) -> [{ id, title, pass, detail, ms }]. */
      qa: { run: (prefix?: string) => runQA(this, prefix), list: listQA },
      grade: () => this.pipeline.grade,
      /** look tuning: glass reflection gain, AO strength / AO view (undefined leaves a value as it is) */
      /** 花城广场's music fountain: start a show now for `seconds`; returns its state */
      fountain: (seconds?: number) => { if (seconds) this.fountain?.force(seconds); return this.fountain?.stats() ?? null; },
      lookdev: (o: { refl?: number; ao?: number; aoView?: boolean } = {}) => {
        if (o.refl !== undefined) GZ.uReflK.value = o.refl;
        if (o.ao !== undefined) this.pipeline.ao = o.ao;
        if (o.aoView !== undefined) this.pipeline.aoView = o.aoView;
        return { refl: GZ.uReflK.value, ao: this.pipeline.ao, aoView: this.pipeline.aoView };
      },
      npc: () => this.brain.entries().map(([id, d]) => ({ id, choice: d.choice, p: d.p, top: d.top, age: +(performance.now() / 1000 - d.at).toFixed(2) })),
      police: () => this.police && { level: this.police.level, units: this.police.cars.map((c) => ({ pos: c.obj.position.toArray().map((v) => +v.toFixed(1)), speed: +c.speed.toFixed(1) })) },
      crimes: () => this.crimes.map((c) => ({ id: c.id, kind: c.kind, age: +(performance.now() / 1000 - c.at).toFixed(1) })),
      jobs: () => this.jobs && { phase: this.jobs.phase, pickup: this.jobs.pickup.name, drop: this.jobs.drop?.name, target: this.jobs.target.pos.toArray(), cash: this.jobs.cash, timeLeft: this.jobs.timeLeft },
      crime: (kind: CrimeKind) => this.crime(kind, this.characters[this.active].root.position),
    };
  }

  dispose(): void {
    this.loop.stop();
    this.input.dispose();
    this.renderer.dispose();
  }
}

function el(sel: string): HTMLElement {
  const e = document.querySelector<HTMLElement>(sel);
  if (!e) throw new Error(`Missing ${sel}`);
  return e;
}

/** Colliders for lamp posts, street trees, signal poles and all street furniture. */
function buildProps(city: CityData, furniture: StreetFurniture, signals: SignalLamps, collision: Collision): PropColliders {
  const props = new PropColliders();
  // posts and trunks stop at the underside of a viaduct above them (no phantom posts on the deck)
  const up = new THREE.Vector3(0, 1, 0), o = new THREE.Vector3();
  const top = (p: THREE.Vector3, h: number) => p.y + Math.min(h, collision.raycastDistance(o.copy(p).setY(p.y + 0.3), up, h) + 0.3);
  for (const [x, y, z] of city.lampPoles) { const p = fromBlender(x, y, z); props.addCircle(p.x, p.z, 0.13, p.y, top(p, 10), 'lamp'); }
  city.treePos.forEach(([x, y, z], i) => { const p = fromBlender(x, y, z); props.addCircle(p.x, p.z, city.treeR[i], p.y - 0.3, top(p, 4), 'tree'); });
  for (const p of signals.poles()) props.addCircle(p.x, p.z, 0.13, p.y, top(p, 5.6), 'signal');
  furniture.addColliders(props);
  props.finish();
  return props;
}

const IDLE_DRIVE: DriveInput = { throttle: 0, steer: 0, handbrake: true };

/** Four 60 m high walls on the map bounds (Blender [x0, y0, x1, y1]) for the static collision: the hard edge. */
function boundaryWalls(b: number[]): THREE.Group {
  const [x0, y0, x1, y1] = b;
  const g = new THREE.Group();
  const wall = (cx: number, cz: number, sx: number, sz: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, 60, sz));
    m.position.set(cx, 20, cz);
    g.add(m);
  };
  const w = x1 - x0, h = y1 - y0, t = 2;
  wall((x0 + x1) / 2, -y1 - t / 2, w + 2 * t, t);
  wall((x0 + x1) / 2, -y0 + t / 2, w + 2 * t, t);
  wall(x0 - t / 2, -(y0 + y1) / 2, t, h + 2 * t);
  wall(x1 + t / 2, -(y0 + y1) / 2, t, h + 2 * t);
  return g;
}

function nextFrame(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** Chapter one needs 发哥炸鸡 a short ride from 麦姐煲仔饭: the nearest other restaurant 150-800 m away takes the name. */
function storyShops(d: { shops: { name: string; kind: string; a: number[] }[] }): void {
  const mai = d.shops.find((s) => s.name === '麦姐煲仔饭');
  if (!mai) return;
  const c = d.shops.filter((s) => s.kind === 'restaurant' && s !== mai)
    .map((s) => ({ s, d: Math.hypot(s.a[0] - mai.a[0], s.a[1] - mai.a[1]) }))
    .filter((x) => x.d > 150 && x.d < 800).sort((a, b) => a.d - b.d);
  if (c[0]) c[0].s.name = '发哥炸鸡';
}
