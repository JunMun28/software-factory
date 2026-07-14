import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * Route host. Each new console surface composes the shared slim top-bar shell.
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `<router-outlet />`,
  styles: ':host { display: block; height: 100%; }',
})
export class App {}
