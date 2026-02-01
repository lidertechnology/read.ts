import { inject, Injectable, signal, WritableSignal } from '@angular/core';
import {   collection,   getDocs,   query,   limit,   startAfter,   where,  QueryConstraint,   CollectionReference,   DocumentData,   DocumentSnapshot,   WhereFilterOp} from 'firebase/firestore';

import { InstanciaFirebase } from './instancia';
import { StateEnum } from '../../global/state-enum';

// --- INTERFACES LOCALES PARA MAYOR COHESIÓN ---

// Interfaz para los filtros de consulta, ahora local en este servicio.
export interface Filtros {
  field: string;
  operator: WhereFilterOp;
  value: any;
}

// Interfaz para el objeto de estado, ahora local en este servicio.
interface StateRead<T> {
  items: (T & { id: string })[];
  state: StateEnum;
  lastDoc: DocumentSnapshot | null;
  hasMore: boolean;
  error: any;
}


@Injectable({ providedIn: 'root' })
export class ReadService<T extends DocumentData> {

  // --- Injecciones y Estado Interno ---
  private firestore = inject(InstanciaFirebase).firestore;
  private _stateEnumRead: WritableSignal<StateRead<T>> = signal({
    items:      [],
    state:      StateEnum.CARGANDO, // CORREGIDO
    lastDoc:    null,
    hasMore:    true,
    error:      null
  });

  // --- Señales Públicas (Tipado Corregido) ---
  public readonly items     = signal<(T & { id: string })[]>([]); // CORREGIDO
  public readonly lastDoc   = signal<DocumentSnapshot | null>(null);
  public readonly hasMore   = signal<boolean>(true);
  public readonly error     = signal<any>(null);


  // --- MÉTODO PARA LECTURAS CON ESTADO Y PAGINACIÓN AUTOMÁTICA ---

  public async obtenerDocumentos(
    collectionName: string,
    limite: number,
    filtros: Filtros[] = []
  ): Promise<void> {

    if (!this.hasMore()) return;

    try {
      const constraints: QueryConstraint[] = [limit(limite)];
      if (this.lastDoc()) {
        constraints.push(startAfter(this.lastDoc()));
      }
      filtros.forEach(f => constraints.push(where(f.field, f.operator, f.value)));

      const q = query(collection(this.firestore, collectionName), ...constraints);
      const snapshot = await getDocs(q);

      // CORREGIDO: El mapeo ahora genera el tipo correcto sin forzar la conversión.
      const newItems = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() as T }));
      this.items.update(current => [...current, ...newItems]);
      
      const lastVisible = snapshot.docs[snapshot.docs.length - 1];
      this.lastDoc.set(lastVisible || null);
      this.hasMore.set(snapshot.docs.length === limite);
      
      this._stateEnumRead.set({
        items: this.items(),
        state: StateEnum.EXITO, // CORREGIDO
        lastDoc: this.lastDoc(),
        hasMore: this.hasMore(),
        error: null
      });

    } catch (error) {
      this.error.set(error);
      // CORREGIDO: Se usa el enum correcto y se actualiza el estado inmutablemente.
      const currentState = this._stateEnumRead();
      this._stateEnumRead.set({ ...currentState, state: StateEnum.ERROR, error });
      console.error('Error al obtener documentos:', error);
    }
  }


  // --- MÉTODO ROBUSTO PARA LECTURAS DE "UN SOLO DISPARO" CON PAGINACIÓN ---

  public async obtenerDocumentosPorFiltro<U>(
    collectionName: string,
    filtros: Filtros[],
    limite: number = 10,
    cursor?: DocumentSnapshot<U> 
  ): Promise<{ data: (U & { id: string })[], nextCursor: DocumentSnapshot<U> | null }> {

    try {
      const colRef = collection(this.firestore, collectionName) as CollectionReference<U>;
      const constraints: QueryConstraint[] = [];

      filtros.forEach(f => constraints.push(where(f.field, f.operator, f.value)));
      
      if (cursor) {
        constraints.push(startAfter(cursor));
      }

      constraints.push(limit(limite));
      
      const q = query(colRef, ...constraints);
      const snapshot = await getDocs(q);
      
      // CORREGIDO: El mapeo ahora genera el tipo correcto sin forzar la conversión.
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() as U }));
      const nextCursor = snapshot.docs[snapshot.docs.length - 1] || null;

      return { data, nextCursor };

    } catch (error) {
      console.error('Error en obtenerDocumentosPorFiltro:', error);
      throw error; 
    }
  }
}
