import { Component, OnInit } from '@angular/core';

// Asegúrate de haber incluido el script de OpenCV (opencv.js) en tu index.html
// <script async src="assets/opencv.js"></script>
declare const cv: any;

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
})
export class AppComponent implements OnInit {
  // Referencias y variables
  video!: HTMLVideoElement;
  detectionTimer: any = null; // Control del setInterval
  iterations = 0; // Contador para evitar loops infinitos

  // Escalado del video
  scaleX = 1; // Relación ancho: video real -> contenedor CSS
  scaleY = 1; // Relación alto: video real -> contenedor CSS

  // Dimensiones del contenedor donde DEBE estar completamente el documento
  containerWidth = 384;
  containerHeight = 272;

  // Ajusta estos valores para mayor precisión
  minFocusThreshold = 180;   // Umbral de nitidez (sube si quieres más precisión, p.ej. 180-200)
  minAreaFraction = 0.6;     // 60% del contenedor
  maxAreaFraction = 0.9;     // 90% del contenedor
  minAspectRatio = 1.4;      // Relación de aspecto mínima
  maxAspectRatio = 1.7;      // Relación de aspecto máxima

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
          width: { ideal: 384 },
          height: { ideal: 272 },
        },
      });
      this.video.srcObject = stream;
      await this.video.play();

      // Ajusta la escala entre el video real y el contenedor CSS
      this.scaleX = this.video.videoWidth / this.containerWidth;
      this.scaleY = this.video.videoHeight / this.containerHeight;

      console.log(
        'Dimensiones reales de la cámara:',
        this.video.videoWidth,
        this.video.videoHeight
      );
      console.log('Escala (X, Y):', this.scaleX, this.scaleY);

      // Inicia el bucle de detección
      this.startDetectionLoop();
    } catch (error) {
      console.error('Error al iniciar la cámara:', error);
      this.showFeedback('Error al acceder a la cámara. Verifica permisos.');
    }
  }

  /**
   * Ejecuta la detección cada 500 ms, hasta un máximo de 12000 iteraciones.
   */
  startDetectionLoop() {
    this.detectionTimer = setInterval(() => {
      this.iterations++;
      if (this.iterations < 12000) {
        const frame = this.captureFrame();
        if (frame) {
          this.processFrame(frame);
        }
      } else {
        clearInterval(this.detectionTimer);
      }
    }, 500);
  }

  /**
   * Captura el fotograma actual del <video> y lo convierte a un cv.Mat para OpenCV.
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
   * 1) Nitidez >= minFocusThreshold
   * 2) Documento completamente dentro [0,0,384,272]
   * 3) Ocupa entre minAreaFraction y maxAreaFraction del área
   * 4) Relación de aspecto dentro del rango [minAspectRatio, maxAspectRatio]
   * 5) Cuatro lados (aproxPolyDP)
   */
  processFrame(frame: any) {
    // 1. Convertir a escala de grises
    const gray = new cv.Mat();
    cv.cvtColor(frame, gray, cv.COLOR_RGBA2GRAY);

    // 2. Verificar nitidez (Laplace)
    const sharpnessValue = this.measureSharpness(gray);
    console.log('Nitidez:', sharpnessValue);

    if (sharpnessValue < this.minFocusThreshold) {
      this.showFeedback(
        'La imagen está borrosa. Ajusta la posición/cámara para enfocar.'
      );
      frame.delete();
      gray.delete();
      return;
    }

    // 3. Preprocesado para contornos
    //    - Suavizado
    const blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

    //    - Canny
    const edges = new cv.Mat();
    cv.Canny(blurred, edges, 50, 150);

    //    - Cierre morfológico para unir bordes “rotos”
    const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);

    // 4. Detección de contornos
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(
      edges,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE
    );

    let largestRect: any | null = null;
    let maxArea = 0;

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);

      // 4.1 Aproximar el contorno a polígonos
      const approx = new cv.Mat();
      const perimeter = cv.arcLength(contour, true);
      cv.approxPolyDP(contour, approx, 0.02 * perimeter, true);

      // Verificamos si es un polígono de 4 vértices (posible rectángulo).
      if (approx.size().height === 4 && cv.isContourConvex(approx)) {
        // boundingRect del polígono aproximado
        const rect = cv.boundingRect(approx);

        // Escalar coordenadas al espacio del contenedor
        const scaledX = rect.x / this.scaleX;
        const scaledY = rect.y / this.scaleY;
        const scaledWidth = rect.width / this.scaleX;
        const scaledHeight = rect.height / this.scaleY;

        // Verificar si está COMPLETAMENTE dentro del recuadro 0..384, 0..272
        const isInsideContainer =
          scaledX >= 0 &&
          scaledY >= 0 &&
          scaledX + scaledWidth <= this.containerWidth &&
          scaledY + scaledHeight <= this.containerHeight;

        if (!isInsideContainer) {
          // console.log('Contorno descartado: fuera del recuadro.');
          approx.delete();
          continue;
        }

        // Calcular área y relación de aspecto
        const rectArea = scaledWidth * scaledHeight;
        const areaRatio = rectArea / (this.containerWidth * this.containerHeight);
        const aspectRatio = scaledWidth / scaledHeight;

        // Validar área y relación de aspecto
        if (
          areaRatio >= this.minAreaFraction &&
          areaRatio <= this.maxAreaFraction &&
          aspectRatio >= this.minAspectRatio &&
          aspectRatio <= this.maxAspectRatio &&
          rectArea > maxArea
        ) {
          largestRect = {
            x: scaledX,
            y: scaledY,
            width: scaledWidth,
            height: scaledHeight,
          };
          maxArea = rectArea;
        }

        approx.delete();
      }
    }

    if (largestRect) {
      this.hideFeedback();
      this.stabilizeDetection(largestRect);
    } else {
      this.showFeedback(
        'Debe verse el documento completo, ocupando el espacio y con el tamaño correcto.'
      );
    }

    // Liberar memoria intermedia
    frame.delete();
    gray.delete();
    blurred.delete();
    edges.delete();
    kernel.delete();
    contours.delete();
    hierarchy.delete();
  }

  /**
   * Calcula la varianza del Laplaciano (nitidez). A mayor valor, más nítida la imagen.
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
   * Si coincide varios frames seguidos, se considera estable.
   */
  stabilizeDetection(currentRect: any) {
    if (
      !this.previousRect ||
      this.areRectsSimilar(this.previousRect, currentRect)
    ) {
      this.consecutiveStableFrames++;
    } else {
      this.consecutiveStableFrames = 0;
    }

    this.previousRect = currentRect;

    if (this.consecutiveStableFrames >= this.stabilityThreshold) {
      // Dibuja el rectángulo final, captura foto, y detén el bucle
      this.drawFinalRect(currentRect);
      console.log('Detección estabilizada: Documento dentro, buen tamaño y nitidez.');

      // Capturar foto
      this.capturePhoto();

      // Detener setInterval
      if (this.detectionTimer) {
        clearInterval(this.detectionTimer);
        this.detectionTimer = null;
      }
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
   * Dibuja un rectángulo verde en contourCanvas y muestra el documento.
   */
  drawFinalRect(rect: any) {
    const contourCanvas = document.getElementById(
      'contourCanvas'
    ) as HTMLCanvasElement;
    contourCanvas.classList.remove('hidden');
    const ctx = contourCanvas.getContext('2d');
    if (!ctx) return;

    // Ajustar canvas al tamaño del video
    contourCanvas.width = this.video.videoWidth;
    contourCanvas.height = this.video.videoHeight;

    // Limpiar y dibujar el frame actual
    ctx.clearRect(0, 0, contourCanvas.width, contourCanvas.height);
    ctx.drawImage(this.video, 0, 0, contourCanvas.width, contourCanvas.height);

    // Dibujar rectángulo
    // Ojo: las coords del rect vienen “escaladas” al contenedor,
    //      para dibujarlo en el canvas del video hay que reescalar de vuelta.
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
    console.log('Foto capturada en Base64:', dataUrl);

    // Aquí podrías:
    // - this.uploadImage(dataUrl);
    // - localStorage.setItem('cedula', dataUrl);
    // - etc.
  }

  /**
   * Muestra un mensaje en el div #feedbackMessage
   */
  showFeedback(msg: string) {
    const feedbackEl = document.getElementById('feedbackMessage');
    if (feedbackEl) {
      feedbackEl.style.display = 'block';
      feedbackEl.innerText = msg;
    }
  }

  /**
   * Oculta el mensaje de retroalimentación si existe
   */
  hideFeedback() {
    const feedbackEl = document.getElementById('feedbackMessage');
    if (feedbackEl) {
      feedbackEl.style.display = 'none';
    }
  }
}
