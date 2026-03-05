import {  Injectable,  signal,  inject,  OnDestroy} from '@angular/core';
import { collection, getDocs, getDoc, getCountFromServer, query, limit, startAfter, orderBy, where, onSnapshot, doc, QueryConstraint, CollectionReference,  DocumentData,  DocumentSnapshot,  WhereFilterOp,  OrderByDirection,  Unsubscribe,} from 'firebase/firestore';
import { InstanciaFirebase } from './firebase-instance.service';

// ═══════════════════════════════════════════════════════════════════
// ENUMS
// ═══════════════════════════════════════════════════════════════════

export enum ReadState {  IDLE    = 'idle',  LOADING = 'cargando',  SUCCESS = 'exito',  ERROR   = 'error'}

// ═══════════════════════════════════════════════════════════════════
// INTERFACES PÚBLICAS
// ═══════════════════════════════════════════════════════════════════

export interface Filtro {  field:    string;  operator: WhereFilterOp;  value:    any;}
export interface Orden {  field:     string;  direction: OrderByDirection; }// 'asc' | 'desc'
export interface QueryOpciones {  filtros?: Filtro[];  orden?:   Orden[];  limite?:  number;}
export interface PaginatedResult<U> {  data:       (U & { id: string })[];  nextCursor: DocumentSnapshot | null;  total?:     number;}


// ═══════════════════════════════════════════════════════════════════
// SERVICIO — Solo Lectura (Firestore)
//
// ── INSTANCIA AISLADA POR COMPONENTE ────────────────────────────
// Declarar siempre en providers[] del @Component.
// Cada componente recibe su propio estado (items, state, etc.).
// Si dos componentes comparten el mismo singleton, sus datos
// se mezclan y contaminan mutuamente.
//
//   @Component({
//     selector:  'app-mi-lista',
//     providers: [ReadService],   // ← instancia propia aquí
//     template:  `...`
//   })
//   export class MiListaComponent {
//     svc = inject<ReadService<MiModelo>>(ReadService);
//   }
//
// ── MÉTODOS DISPONIBLES ──────────────────────────────────────────
// obtenerDocumentos()     Lista paginada reactiva. Scroll infinito.
// obtenerPorId()          Un documento por ID. Soporta caché.
// consultar()             One-shot sin tocar el estado reactivo.
// escuchar()              Lista en tiempo real (onSnapshot).
// escucharDocumento()     Documento único en tiempo real.
// contarDocumentos()      Conteo sin descargar documentos.
// buscarPorTexto()        Búsqueda por prefijo en un campo texto.
// consultarGrupo()        Sub-colecciones con collectionGroup.
//
// ── REGLAS DE USO ────────────────────────────────────────────────
// 1. Llamar reset() siempre que cambien filtros u orden,
//    antes de volver a llamar obtenerDocumentos().
//
// 2. Si usas escuchar() o escucharDocumento(), cancelar
//    la suscripción en ngOnDestroy() para evitar memory leaks:
//      ngOnDestroy() { this.svc.detenerEscucha('mi-key'); }
//
// 3. El parámetro usarCache: true en obtenerPorId() y consultar()
//    evita re-fetch mientras el TTL no expire (default 60s).
//    Cambiar TTL con: this.svc.setCacheTTL(ms)
//    Invalidar caché con: this.svc.invalidarCache(key?)
//
// ── SEÑALES PÚBLICAS ─────────────────────────────────────────────
// items()    → (T & { id: string })[]   Documentos acumulados
// state()    → ReadState                'idle'|'cargando'|'exito'|'error'
// hasMore()  → boolean                  false cuando no hay más páginas
// error()    → any                      Último error capturado
// total()    → number | null            Resultado de contarDocumentos()
//
// ═══════════════════════════════════════════════════════════════════

@Injectable({ providedIn: 'any' })
export class ReadService<T extends DocumentData> implements OnDestroy {

  private firestore = inject(InstanciaFirebase).firestore;

  // ── Caché interna ─────────────────────────────────────────────────
  private _cache = new Map<string, { data: any; timestamp: number }>();
  private _cacheTTL = 60_000; // 60 segundos por defecto

  // ── Suscripciones activas (tiempo real) ───────────────────────────
  private _subscriptions = new Map<string, Unsubscribe>();

  // ── Cursor de paginación (privado) ────────────────────────────────
  private _lastDoc = signal<DocumentSnapshot | null>(null);

  // ── Señales públicas ──────────────────────────────────────────────
  public readonly items   = signal<(T & { id: string })[]>([]);
  public readonly state   = signal<ReadState>(ReadState.IDLE);
  public readonly hasMore = signal<boolean>(true);
  public readonly error   = signal<any>(null);
  public readonly total   = signal<number | null>(null);


  // ─────────────────────────────────────────────────────────────────
  // reset()
  // Limpia el estado para reutilizar el servicio con nuevos filtros
  // ─────────────────────────────────────────────────────────────────
  public reset(): void {
    this.items.set([]);
    this.state.set(ReadState.IDLE);
    this.hasMore.set(true);
    this.error.set(null);
    this.total.set(null);
    this._lastDoc.set(null);
  }


  // ─────────────────────────────────────────────────────────────────
  // setCacheTTL()
  // Cambia el tiempo de vida del caché (ms). Default: 60000
  // ─────────────────────────────────────────────────────────────────
  public setCacheTTL(ms: number): void {
    this._cacheTTL = ms;
  }


  // ═══════════════════════════════════════════════════════════════════
  // 1. LISTA PAGINADA CON ESTADO REACTIVO
  //    Acumula resultados en items[]. Ideal para scroll infinito
  //    o botón "cargar más".
  //    Llama reset() antes de cambiar filtros u orden.
  // ═══════════════════════════════════════════════════════════════════
  public async obtenerDocumentos(
    collectionName: string,
    opciones: QueryOpciones = {}
  ): Promise<void> {

    if (!this.hasMore() || this.state() === ReadState.LOADING) return;

    this.state.set(ReadState.LOADING);
    this.error.set(null);

    try {
      const { filtros = [], orden = [], limite = 10 } = opciones;
      const constraints: QueryConstraint[] = [];

      filtros.forEach(f => constraints.push(where(f.field, f.operator, f.value)));
      orden.forEach(o   => constraints.push(orderBy(o.field, o.direction)));

      const cursor = this._lastDoc();
      if (cursor) constraints.push(startAfter(cursor));

      constraints.push(limit(limite));

      const q        = query(collection(this.firestore, collectionName), ...constraints);
      const snapshot = await getDocs(q);

      const newItems = snapshot.docs.map(d => ({ id: d.id, ...d.data() as T }));
      this.items.update(prev => [...prev, ...newItems]);

      this._lastDoc.set(snapshot.docs.at(-1) ?? null);
      this.hasMore.set(snapshot.docs.length === limite);
      this.state.set(ReadState.SUCCESS);

    } catch (err) {
      this._handleError('obtenerDocumentos', err);
    }
  }


  // ═══════════════════════════════════════════════════════════════════
  // 2. CONSULTA ONE-SHOT CON CURSOR EXTERNO
  //    No modifica el estado reactivo del servicio.
  //    Ideal para modales, sub-consultas, búsquedas puntuales.
  //    Soporta caché opcional.
  // ═══════════════════════════════════════════════════════════════════
  public async consultar<U extends DocumentData>(
    collectionName: string,
    opciones:        QueryOpciones = {},
    cursor?:         DocumentSnapshot,
    usarCache:       boolean = false
  ): Promise<PaginatedResult<U>> {

    const cacheKey = this._buildCacheKey(collectionName, opciones, cursor);

    if (usarCache) {
      const cached = this._getFromCache<PaginatedResult<U>>(cacheKey);
      if (cached) return cached;
    }

    try {
      const { filtros = [], orden = [], limite = 10 } = opciones;
      const colRef      = collection(this.firestore, collectionName) as CollectionReference<U>;
      const constraints: QueryConstraint[] = [];

      filtros.forEach(f => constraints.push(where(f.field, f.operator, f.value)));
      orden.forEach(o   => constraints.push(orderBy(o.field, o.direction)));
      if (cursor)         constraints.push(startAfter(cursor));
      constraints.push(limit(limite));

      const snapshot   = await getDocs(query(colRef, ...constraints));
      const data       = snapshot.docs.map(d => ({ id: d.id, ...d.data() as U }));
      const nextCursor = snapshot.docs.at(-1) ?? null;
      const result     = { data, nextCursor };

      if (usarCache) this._setCache(cacheKey, result);

      return result;

    } catch (err) {
      console.error('[ReadService] consultar:', err);
      throw err;
    }
  }


  // ═══════════════════════════════════════════════════════════════════
  // 3. DOCUMENTO ÚNICO POR ID
  //    Soporta caché opcional.
  // ═══════════════════════════════════════════════════════════════════
  public async obtenerPorId(
    collectionName: string,
    id:             string,
    usarCache:      boolean = false
  ): Promise<(T & { id: string }) | null> {

    const cacheKey = `doc::${collectionName}::${id}`;

    if (usarCache) {
      const cached = this._getFromCache<T & { id: string }>(cacheKey);
      if (cached) return cached;
    }

    try {
      const docRef  = doc(this.firestore, collectionName, id);
      const docSnap = await getDoc(docRef);

      if (!docSnap.exists()) {
        console.warn(`[ReadService] No existe: ${collectionName}/${id}`);
        return null;
      }

      const result = { id: docSnap.id, ...docSnap.data() as T };
      if (usarCache) this._setCache(cacheKey, result);

      return result;

    } catch (err) {
      console.error('[ReadService] obtenerPorId:', err);
      throw err;
    }
  }


  // ═══════════════════════════════════════════════════════════════════
  // 4. TIEMPO REAL — onSnapshot
  //    Escucha cambios en Firestore y actualiza items[] automáticamente.
  //    key: identificador único para la suscripción (permite múltiples).
  //    Llama detenerEscucha(key) para cancelar.
  // ═══════════════════════════════════════════════════════════════════
  public escuchar(
    collectionName: string,
    opciones:        QueryOpciones = {},
    key:             string = 'default'
  ): void {

    // Cancelar suscripción previa con la misma key
    this.detenerEscucha(key);

    this.state.set(ReadState.LOADING);
    this.error.set(null);

    try {
      const { filtros = [], orden = [], limite } = opciones;
      const constraints: QueryConstraint[] = [];

      filtros.forEach(f => constraints.push(where(f.field, f.operator, f.value)));
      orden.forEach(o   => constraints.push(orderBy(o.field, o.direction)));
      if (limite)         constraints.push(limit(limite));

      const q           = query(collection(this.firestore, collectionName), ...constraints);
      const unsubscribe = onSnapshot(
        q,
        snapshot => {
          const data = snapshot.docs.map(d => ({ id: d.id, ...d.data() as T }));
          this.items.set(data);
          this.state.set(ReadState.SUCCESS);
          this.error.set(null);
        },
        err => this._handleError('escuchar', err)
      );

      this._subscriptions.set(key, unsubscribe);

    } catch (err) {
      this._handleError('escuchar', err);
    }
  }


  // ═══════════════════════════════════════════════════════════════════
  // 5. TIEMPO REAL — documento único por ID
  // ═══════════════════════════════════════════════════════════════════
  public escucharDocumento(
    collectionName: string,
    id:             string,
    callback:       (data: (T & { id: string }) | null) => void,
    key:            string = 'doc-default'
  ): void {

    this.detenerEscucha(key);

    const docRef      = doc(this.firestore, collectionName, id);
    const unsubscribe = onSnapshot(
      docRef,
      snap => {
        if (snap.exists()) {
          callback({ id: snap.id, ...snap.data() as T });
        } else {
          callback(null);
        }
      },
      err => this._handleError('escucharDocumento', err)
    );

    this._subscriptions.set(key, unsubscribe);
  }


  // ═══════════════════════════════════════════════════════════════════
  // 6. CONTEO DE DOCUMENTOS
  //    Usa getCountFromServer() sin descargar los documentos.
  //    Actualiza la señal total().
  // ═══════════════════════════════════════════════════════════════════
  public async contarDocumentos(
    collectionName: string,
    filtros:        Filtro[] = []
  ): Promise<number> {

    try {
      const constraints: QueryConstraint[] = filtros.map(
        f => where(f.field, f.operator, f.value)
      );

      const q        = query(collection(this.firestore, collectionName), ...constraints);
      const snapshot = await getCountFromServer(q);
      const count    = snapshot.data().count;

      this.total.set(count);
      return count;

    } catch (err) {
      console.error('[ReadService] contarDocumentos:', err);
      throw err;
    }
  }


  // ═══════════════════════════════════════════════════════════════════
  // 7. BÚSQUEDA POR PREFIJO EN UN CAMPO DE TEXTO
  //    Simula "startsWith" en Firestore usando rango de strings.
  //    Requiere que el campo esté indexado.
  // ═══════════════════════════════════════════════════════════════════
  public async buscarPorTexto<U extends DocumentData>(
    collectionName: string,
    campo:          string,
    texto:          string,
    opciones:        QueryOpciones = {}
  ): Promise<(U & { id: string })[]> {

    if (!texto.trim()) return [];

    const fin  = texto.trim() + '\uf8ff';
    const inicio = texto.trim();

    const filtrosExtra: Filtro[] = [
      { field: campo, operator: '>=', value: inicio },
      { field: campo, operator: '<=', value: fin }
    ];

    const resultado = await this.consultar<U>(collectionName, {
      ...opciones,
      filtros: [...(opciones.filtros ?? []), ...filtrosExtra],
      orden:   [{ field: campo, direction: 'asc' }, ...(opciones.orden ?? [])]
    });

    return resultado.data;
  }


  // ═══════════════════════════════════════════════════════════════════
  // 8. CONSULTA EN MÚLTIPLES COLECCIONES (collectionGroup)
  //    Lee documentos del mismo nombre en sub-colecciones anidadas.
  // ═══════════════════════════════════════════════════════════════════
  public async consultarGrupo<U extends DocumentData>(
    groupName: string,
    opciones:   QueryOpciones = {}
  ): Promise<(U & { id: string })[]> {

    try {
      const { filtros = [], orden = [], limite = 50 } = opciones;
      const { collectionGroup } = await import('firebase/firestore');

      const constraints: QueryConstraint[] = [];
      filtros.forEach(f => constraints.push(where(f.field, f.operator, f.value)));
      orden.forEach(o   => constraints.push(orderBy(o.field, o.direction)));
      constraints.push(limit(limite));

      const q        = query(collectionGroup(this.firestore, groupName), ...constraints);
      const snapshot = await getDocs(q);

      return snapshot.docs.map(d => ({ id: d.id, ...d.data() as U }));

    } catch (err) {
      console.error('[ReadService] consultarGrupo:', err);
      throw err;
    }
  }


  // ═══════════════════════════════════════════════════════════════════
  // 9. INVALIDAR CACHÉ
  //    Limpia una entrada específica o todo el caché.
  // ═══════════════════════════════════════════════════════════════════
  public invalidarCache(key?: string): void {
    if (key) {
      this._cache.delete(key);
    } else {
      this._cache.clear();
    }
  }


  // ═══════════════════════════════════════════════════════════════════
  // 10. DETENER ESCUCHA EN TIEMPO REAL
  // ═══════════════════════════════════════════════════════════════════
  public detenerEscucha(key: string = 'default'): void {
    const unsub = this._subscriptions.get(key);
    if (unsub) {
      unsub();
      this._subscriptions.delete(key);
    }
  }

  public detenerTodasLasEscuchas(): void {
    this._subscriptions.forEach(unsub => unsub());
    this._subscriptions.clear();
  }


  // ─────────────────────────────────────────────────────────────────
  // LIFECYCLE — cancelar todo al destruir el componente
  // ─────────────────────────────────────────────────────────────────
  ngOnDestroy(): void {
    this.detenerTodasLasEscuchas();
    this._cache.clear();
  }


  // ─────────────────────────────────────────────────────────────────
  // MÉTODOS PRIVADOS
  // ─────────────────────────────────────────────────────────────────
  private _handleError(method: string, err: any): void {
    this.error.set(err);
    this.state.set(ReadState.ERROR);
    console.error(`[ReadService] ${method}:`, err);
  }

  private _buildCacheKey(
    col:      string,
    opciones: QueryOpciones,
    cursor?:  DocumentSnapshot | null
  ): string {
    return `${col}::${JSON.stringify(opciones)}::${cursor?.id ?? 'start'}`;
  }

  private _getFromCache<R>(key: string): R | null {
    const entry = this._cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this._cacheTTL) {
      this._cache.delete(key);
      return null;
    }
    return entry.data as R;
  }

  private _setCache(key: string, data: any): void {
    this._cache.set(key, { data, timestamp: Date.now() });
  }
}
