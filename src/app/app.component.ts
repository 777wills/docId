import { Component, OnInit } from '@angular/core';

declare const cv: any;

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
})
export class AppComponent implements OnInit {
  video!: HTMLVideoElement;
  detectionTimer: any = null; // Control del setInterval

  // Escalado del video
  scaleX = 1; // Relación ancho: video real -> contenedor CSS
  scaleY = 1; // Relación alto: video real -> contenedor CSS

  // Dimensiones del contenedor donde DEBE estar completamente el documento
  containerWidth = 384;
  containerHeight = 272;

  // Ajustes de detección
  // Se mantiene un threshold de nitidez mediano
  minFocusThreshold = 120;

  minAreaFraction = 0.3;
  maxAreaFraction = 0.9;
  minAspectRatio = 1.0;
  maxAspectRatio = 4.0;

  // Estabilización
  previousRect: any | null = null;
  consecutiveStableFrames = 0;
  stabilityThreshold = 5; // Número de frames consecutivos para estabilizar

  ngOnInit() {
    this.video = document.querySelector('video') as HTMLVideoElement;
    this.startCamera();
  }

  /**
   * Solicita acceso a la cámara y, si lo obtiene, muestra el stream en <video>.
   */
  async startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' }, // Forzar cámara trasera
          width: { ideal: 384 },
          height: { ideal: 272 },
        },
      });

      this.video.srcObject = stream;
      await this.video.play();

      // Ajusta la escala entre el video real y el contenedor CSS
      this.scaleX = this.video.videoWidth / this.containerWidth;
      this.scaleY = this.video.videoHeight / this.containerHeight;

      this.startDetectionLoop();
    } catch (error) {
      this.showFeedback('Error al acceder a la cámara. Verifica permisos.');
      console.error('Error al iniciar la cámara:', error);
    }
  }

  /**
   * Ejecuta la detección cada 500 ms.
   */
  startDetectionLoop() {
    this.detectionTimer = setInterval(() => {
      const frame = this.captureFrame();
      if (frame) {
        this.processFrame(frame);
      }
    }, 500);
  }

  /**
   * Captura el fotograma actual del <video> y lo convierte a un cv.Mat.
   */
  captureFrame(): any | null {
    const canvas = document.createElement('canvas');
    canvas.width = this.video.videoWidth;
    canvas.height = this.video.videoHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return cv.matFromImageData(imageData);
  }

  /**
   * Procesa el fotograma para verificar:
   * - Nitidez
   * - Documento dentro del contenedor y con 4 vértices
   * - Área suficiente y relación de aspecto
   */
  processFrame(frame: any) {
    // 1. Convertir a escala de grises
    const gray = new cv.Mat();
    cv.cvtColor(frame, gray, cv.COLOR_RGBA2GRAY);

    // 2. Verificar nitidez
    const sharpnessValue = this.measureSharpness(gray);
    this.showSharpness(sharpnessValue);

    if (sharpnessValue < this.minFocusThreshold) {
      this.showFeedback('La imagen está borrosa. Nitidez: ' + sharpnessValue.toFixed(2));
      // Liberar
      frame.delete();
      gray.delete();
      return;
    }

    // 3. Preprocesado para contornos: Suavizado, Canny, Cierre morfológico
    const blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

    const edges = new cv.Mat();
    cv.Canny(blurred, edges, 50, 150);

    const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);

    // 4. Buscar contornos
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let largestRect: any | null = null;
    let maxArea = 0;

    // Mensaje auxiliar para cada contorno
    let debugInfo = '';

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const approx = new cv.Mat();
      const perimeter = cv.arcLength(contour, true);
      cv.approxPolyDP(contour, approx, 0.02 * perimeter, true);

      // ¿Tiene 4 vértices?
      const vertices = approx.size().height;
      if (vertices === 4 && cv.isContourConvex(approx)) {
        const rect = cv.boundingRect(approx);

        // Escalar coords a nuestro contenedor
        const scaledX = rect.x / this.scaleX;
        const scaledY = rect.y / this.scaleY;
        const scaledW = rect.width / this.scaleX;
        const scaledH = rect.height / this.scaleY;
        const scaledX2 = scaledX + scaledW;
        const scaledY2 = scaledY + scaledH;

        // ¿Está dentro de [0,0, 384, 272]?
        const isInside =
          scaledX >= 0 &&
          scaledY >= 0 &&
          scaledX2 <= this.containerWidth &&
          scaledY2 <= this.containerHeight;

        // Calcular área
        const rectArea = scaledW * scaledH;
        const areaRatio = rectArea / (this.containerWidth * this.containerHeight);
        const aspectRatio = scaledW / scaledH;

        // Construir info de debug
        debugInfo += `Contorno ${i}: 4 vértices,
          scaledX=${scaledX.toFixed(2)}, scaledY=${scaledY.toFixed(2)},
          w=${scaledW.toFixed(2)}, h=${scaledH.toFixed(2)},
          areaRatio=${areaRatio.toFixed(2)}, aspectRatio=${aspectRatio.toFixed(2)},
          inside=${isInside}.\n`;

        // Validar si cumple todo
        if (!isInside) {
          debugInfo += `--> Descartado: fuera del contenedor.\n`;
        } else if (
          areaRatio < this.minAreaFraction ||
          areaRatio > this.maxAreaFraction
        ) {
          debugInfo += `--> Descartado: areaRatio fuera de [${this.minAreaFraction}, ${this.maxAreaFraction}].\n`;
        } else if (
          aspectRatio < this.minAspectRatio ||
          aspectRatio > this.maxAspectRatio
        ) {
          debugInfo += `--> Descartado: aspectRatio fuera de [${this.minAspectRatio}, ${this.maxAspectRatio}].\n`;
        } else {
          // TODO: Si llega aquí, es un contorno válido
          if (rectArea > maxArea) {
            largestRect = {
              x: scaledX,
              y: scaledY,
              width: scaledW,
              height: scaledH,
            };
            maxArea = rectArea;
          }
        }
      } else {
        debugInfo += `Contorno ${i}: ${vertices} vértices. Descartado.\n`;
      }

      approx.delete();
    }

    // Mostrar debug de contornos en pantalla
    this.showDebugInfo(debugInfo);

    if (largestRect) {
      this.hideFeedback();
      this.stabilizeDetection(largestRect);
    } else {
      this.showFeedback('Ningún contorno válido. Revisa el debug.');
    }

    // Liberar memoria
    frame.delete();
    gray.delete();
    blurred.delete();
    edges.delete();
    kernel.delete();
    contours.delete();
    hierarchy.delete();
  }

  /**
   * Calcula la varianza del Laplaciano (nitidez).
   */
  measureSharpness(grayMat: any): number {
    const lap = new cv.Mat();
    cv.Laplacian(grayMat, lap, cv.CV_64F);

    const data = lap.data64F;
    if (!data || data.length === 0) {
      lap.delete();
      return 0;
    }

    // Media
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i];
    }
    const mean = sum / data.length;

    // Varianza
    let varianceSum = 0;
    for (let i = 0; i < data.length; i++) {
      const diff = data[i] - mean;
      varianceSum += diff * diff;
    }
    const variance = varianceSum / data.length;

    lap.delete();
    return variance;
  }

  /**
   * Comprueba si el rect actual es similar al anterior.
   */
  stabilizeDetection(currentRect: any) {
    if (!this.previousRect || this.areRectsSimilar(this.previousRect, currentRect)) {
      this.consecutiveStableFrames++;
    } else {
      this.consecutiveStableFrames = 0;
    }

    this.previousRect = currentRect;

    if (this.consecutiveStableFrames >= this.stabilityThreshold) {
      // Captura final
      this.drawFinalRect(currentRect);
      this.capturePhoto();

      // Detener loop
      if (this.detectionTimer) {
        clearInterval(this.detectionTimer);
        this.detectionTimer = null;
      }

      this.showDebugInfo('¡Documento capturado!');
    }
  }

  /**
   * Verifica si dos rect son cercanos en posición y tamaño.
   */
  areRectsSimilar(rect1: any, rect2: any): boolean {
    const positionThreshold = 10;
    const sizeThreshold = 20;
    return (
      Math.abs(rect1.x - rect2.x) < positionThreshold &&
      Math.abs(rect1.y - rect2.y) < positionThreshold &&
      Math.abs(rect1.width - rect2.width) < sizeThreshold &&
      Math.abs(rect1.height - rect2.height) < sizeThreshold
    );
  }

  /**
   * Dibuja un rectángulo verde en contourCanvas.
   */
  drawFinalRect(rect: any) {
    const contourCanvas = document.getElementById('contourCanvas') as HTMLCanvasElement;
    contourCanvas.classList.remove('hidden');
    const ctx = contourCanvas.getContext('2d');
    if (!ctx) return;

    contourCanvas.width = this.video.videoWidth;
    contourCanvas.height = this.video.videoHeight;

    ctx.clearRect(0, 0, contourCanvas.width, contourCanvas.height);
    ctx.drawImage(this.video, 0, 0, contourCanvas.width, contourCanvas.height);

    ctx.strokeStyle = 'green';
    ctx.lineWidth = 4;
    ctx.strokeRect(
      rect.x * this.scaleX,
      rect.y * this.scaleY,
      rect.width * this.scaleX,
      rect.height * this.scaleY
    );
  }

  /**
   * Captura la imagen final del video en Base64.
   */
  capturePhoto() {
    const canvas = document.createElement('canvas');
    canvas.width = this.video.videoWidth;
    canvas.height = this.video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');

    console.log('Imagen capturada en Base64:', dataUrl);

    // Muestra en debug
    this.showDebugInfo('Foto capturada. Base64: ' + dataUrl.substring(0, 50) + '...');
  }

  /**
   * Muestra un mensaje en el div #feedbackMessage.
   */
  showFeedback(msg: string) {
    const feedbackEl = document.getElementById('feedbackMessage');
    if (feedbackEl) {
      feedbackEl.style.display = 'block';
      feedbackEl.innerText = msg;
    }
  }

  /**
   * Oculta el mensaje de retroalimentación si existe.
   */
  hideFeedback() {
    const feedbackEl = document.getElementById('feedbackMessage');
    if (feedbackEl) {
      feedbackEl.style.display = 'none';
    }
  }

  /**
   * Muestra la nitidez en un <div id="sharpnessMessage">.
   */
  showSharpness(value: number) {
    const sharpnessEl = document.getElementById('sharpnessMessage');
    if (sharpnessEl) {
      sharpnessEl.style.display = 'block';
      sharpnessEl.innerText = `Nitidez: ${value.toFixed(2)}`;
    }
  }

  /**
   * Muestra información extra de debug en <div id="debugInfo">.
   */
  showDebugInfo(info: string) {
    const debugEl = document.getElementById('debugInfo');
    if (debugEl) {
      debugEl.style.whiteSpace = 'pre-wrap'; // Para que \n se vea como salto de línea
      debugEl.innerText = info;
    }
  }
}
