import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { resolvePrimaryRuntime } from '@deepseek-ai/dsh-tool-workspace-dependencies'
import { createConverter } from '@deepseek-ai/libreoffice-kit'
const execute = promisify(execFile)
const office = resolve(process.argv[2] ?? '../agent-electron-client/resources/dsh-office')
const entries = await resolvePrimaryRuntime(join(office, 'primary-runtime'))
const directory = await mkdtemp(join(tmpdir(), 'nuwax-dsh-office-'))
let converter
try {
  await execute(entries.python, ['-c', `
import sys
from pathlib import Path
from docx import Document
from pptx import Presentation
from openpyxl import Workbook, load_workbook
p=Path(sys.argv[1])
d=Document(); d.add_paragraph('Nuwax Office integration'); d.save(p/'document.docx')
d=Document(p/'document.docx'); d.add_paragraph('Edited by bundled Python'); d.save(p/'edited.docx')
r=Presentation(); s=r.slides.add_slide(r.slide_layouts[1]); s.shapes.title.text='Nuwax Office'; r.save(p/'slides.pptx')
r=Presentation(p/'slides.pptx'); r.slides[0].shapes.title.text='Edited slides'; r.save(p/'edited.pptx')
w=Workbook(); w.active['A1']=20; w.active['B1']=22; w.active['C1']='=A1+B1'; w.save(p/'sheet.xlsx')
w=load_workbook(p/'sheet.xlsx'); w.active['A2']='Edited workbook'; w.save(p/'edited.xlsx')
`, directory], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: entries.pythonPackages }, timeout: 30000 })
  converter = await createConverter({ timeoutMs: 120000, fontMetadataCacheDirectory: false })
  for (const suffix of ['docx', 'pptx', 'xlsx']) {
    const result = await converter.convert({ inputPath: join(directory, 'edited.' + suffix), outputPath: join(directory, suffix + '.pdf') })
    assert.equal((await readFile(join(directory, suffix + '.pdf'))).subarray(0, 5).toString(), '%PDF-')
    console.log(JSON.stringify({ operation: 'convert', suffix, backend: result.backend }))
  }
  await converter.recalculate({ inputPath: join(directory, 'edited.xlsx'), outputPath: join(directory, 'recalculated.xlsx') })
  const value = await execute(entries.python, ['-c', "from openpyxl import load_workbook; import sys; print(load_workbook(sys.argv[1], data_only=True).active['C1'].value)", join(directory, 'recalculated.xlsx')], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: entries.pythonPackages } })
  assert.equal(Number(value.stdout.trim()), 42)
  await converter.renderImages({ inputPath: join(directory, 'edited.docx'), outputDir: join(directory, 'pages') })
  const manifest = JSON.parse(await readFile(join(directory, 'pages/manifest.json'), 'utf8'))
  assert.ok(manifest)
  if (process.platform === 'darwin') {
    const { verifySignedPython } = await import('./office-signature-smoke.mjs')
    await verifySignedPython(entries.python)
  }
  console.log(JSON.stringify({ level: 'bundled-office-native', createAndEdit: ['docx', 'pptx', 'xlsx'], recalculate: 42, renderImages: true }))
} finally { await converter?.dispose(); await rm(directory, { recursive: true, force: true }) }
