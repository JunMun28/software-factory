import { TestBed } from '@angular/core/testing';

import { FilesService } from '../../services/files.service';
import { FilesPanel } from './files-panel';

describe('FilesPanel', () => {
  it('exposes the selected file with aria-current', async () => {
    await TestBed.configureTestingModule({ imports: [FilesPanel] }).compileComponents();
    const filesService = TestBed.inject(FilesService);
    const fixture = TestBed.createComponent(FilesPanel);
    fixture.detectChanges();

    filesService.files.set([
      { path: 'src/app.ts', status: 'modified' },
      { path: 'src/styles.css', status: 'unchanged' },
    ]);
    filesService.selectedPath.set('src/app.ts');
    fixture.detectChanges();

    const appFile: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[data-file-path="src/app.ts"]',
    );
    const stylesFile: HTMLButtonElement = fixture.nativeElement.querySelector(
      '[data-file-path="src/styles.css"]',
    );
    expect(appFile.getAttribute('aria-current')).toBe('true');
    expect(stylesFile.hasAttribute('aria-current')).toBe(false);
  });
});
