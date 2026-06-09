/**
 * carousel.js — Build a PDF carousel from slide data (no external image API needed)
 *
 * Creates a clean, minimal PDF where each slide is a full page.
 * Uses pdf-lib with standard Type1 fonts (Helvetica) — no font files needed.
 *
 * Usage (imported):
 *   import { buildCarouselPdf } from './carousel.js';
 *   const pdfBytes = await buildCarouselPdf(carouselData, clientName);
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const W = 1080;
const H = 1080;

const COLORS = {
  bg: rgb(0.055, 0.059, 0.071),          // #0e0f12
  accent: rgb(0.855, 0.427, 0.176),       // warm orange
  white: rgb(0.9, 0.91, 0.93),
  muted: rgb(0.54, 0.565, 0.627),
  slide_bg: rgb(0.086, 0.094, 0.114),     // slightly lighter than bg
};

function wrapText(text, font, fontSize, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let current = '';

  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(test, fontSize) <= maxWidth) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function drawSlideBackground(page, isFirst = false) {
  page.drawRectangle({
    x: 0, y: 0, width: W, height: H,
    color: COLORS.bg,
  });

  if (isFirst) {
    page.drawRectangle({
      x: 0, y: H * 0.6, width: W, height: H * 0.4,
      color: COLORS.slide_bg,
    });
  }

  page.drawLine({
    start: { x: 48, y: 24 },
    end: { x: W - 48, y: 24 },
    thickness: 1,
    color: rgb(0.15, 0.16, 0.19),
  });
}

function drawSlideNumber(page, current, total, font, boldFont) {
  const label = `${String(current).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;
  page.drawText(label, {
    x: 48, y: H - 60,
    size: 18,
    font,
    color: COLORS.muted,
  });
}

function drawAccentBar(page, x, y, width = 6, height = 64) {
  page.drawRectangle({ x, y, width, height, color: COLORS.accent });
}

async function buildCarouselPdf(carouselData, clientName = '') {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);

  const slides = carouselData.slides;
  const total = slides.length;

  for (let i = 0; i < total; i++) {
    const slide = slides[i];
    const isFirst = i === 0;
    const page = pdf.addPage([W, H]);

    drawSlideBackground(page, isFirst);

    if (!isFirst) {
      drawSlideNumber(page, i + 1, total, font, boldFont);
    }

    if (isFirst) {
      page.drawText(carouselData.title || slide.headline, {
        x: 48, y: H * 0.7,
        size: 64,
        font: boldFont,
        color: COLORS.white,
        maxWidth: W - 96,
      });

      const lines = wrapText(slide.body, font, 24, W - 96);
      lines.forEach((line, li) => {
        page.drawText(line, {
          x: 48, y: H * 0.56 - li * 34,
          size: 24, font, color: COLORS.muted,
        });
      });

      page.drawText('Swipe  >', {
        x: W - 140, y: 52,
        size: 18, font, color: COLORS.accent,
      });
    } else {
      drawAccentBar(page, 48, H - 160);

      const headLines = wrapText(slide.headline.toUpperCase(), boldFont, 52, W - 96);
      headLines.forEach((line, li) => {
        page.drawText(line, {
          x: 68, y: H - 140 - li * 62,
          size: 52, font: boldFont, color: COLORS.white,
        });
      });

      const bodyY = H - 140 - headLines.length * 62 - 48;
      const bodyLines = wrapText(slide.body, font, 26, W - 96);
      bodyLines.forEach((line, li) => {
        page.drawText(line, {
          x: 48, y: bodyY - li * 38,
          size: 26, font, color: COLORS.muted,
        });
      });

      if (slide.note) {
        page.drawText(slide.note, {
          x: 48, y: 60,
          size: 18, font, color: COLORS.accent,
        });
      }

      if (i === total - 1) {
        page.drawText('Save this ^', {
          x: W - 180, y: 52,
          size: 18, font, color: COLORS.accent,
        });
      }
    }

    if (clientName) {
      page.drawText(`— ${clientName}`, {
        x: 48, y: 52,
        size: 16, font, color: COLORS.muted,
      });
    }
  }

  return pdf.save();
}

export { buildCarouselPdf };
